// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { type Sample, type Uptime, medianLatency, tally } from "./uptime";

/** How long single probes are kept. A day's totals are kept for good once the
 * day is over. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The SQL the store needs: a Durable Object's storage in production, Bun's
 * SQLite in tests. Both are SQLite. */
export interface Sql {
  /** Runs one statement and returns its rows. */
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
  /** Runs fn so that its writes land together or not at all. */
  transaction(fn: () => void): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS probes (
    server_id  TEXT    NOT NULL,
    vantage    TEXT    NOT NULL,
    ts         INTEGER NOT NULL, -- Unix milliseconds
    ok         INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    err_class  TEXT    NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS probes_server_ts ON probes (server_id, ts)`,
  `CREATE TABLE IF NOT EXISTS daily (
    server_id        TEXT    NOT NULL,
    day              INTEGER NOT NULL, -- days since 1970-01-01, UTC
    up_minutes       INTEGER NOT NULL,
    observed_minutes INTEGER NOT NULL,
    p50_ms           INTEGER NOT NULL,
    PRIMARY KEY (server_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS last_ok (
    server_id TEXT    PRIMARY KEY,
    ts        INTEGER NOT NULL
  )`,
  // The last day whose total is in daily, so a day's close reads only the
  // days not closed yet rather than every probe kept.
  `CREATE TABLE IF NOT EXISTS rolled (
    server_id TEXT    PRIMARY KEY,
    day       INTEGER NOT NULL
  )`,
];

/** A UTC day, counted from 1970-01-01. */
export const dayOf = (ms: number): number => Math.floor(ms / MS_PER_DAY);
export const dayStart = (day: number): number => day * MS_PER_DAY;
export const dayString = (day: number): string => new Date(dayStart(day)).toISOString().slice(0, 10);

/** One server's record for one day. */
export interface DayTotal {
  day: number;
  uptime: Uptime;
  p50Ms: number;
}

interface ProbeRow {
  vantage: string;
  ts: number;
  ok: number;
  latency_ms: number;
  err_class: string;
}

const toSample = (r: ProbeRow): Sample => ({
  vantage: r.vantage,
  at: r.ts,
  ok: r.ok !== 0,
  latencyMs: r.latency_ms,
  err: r.err_class,
});

export class Store {
  constructor(private readonly sql: Sql) {
    for (const s of SCHEMA) sql.exec(s);
  }

  /** Records samples of the server with id: one row each, nothing else.
   * When it last answered is kept apart, by saveLastOK, since writing it on
   * every probe would double what a day writes. */
  add(id: string, ...samples: Sample[]): void {
    this.sql.transaction(() => {
      for (const s of samples) {
        this.sql.exec(
          `INSERT INTO probes (server_id, vantage, ts, ok, latency_ms, err_class) VALUES (?, ?, ?, ?, ?, ?)`,
          id, s.vantage, s.at, s.ok ? 1 : 0, Math.round(s.latencyMs), s.err,
        );
      }
    });
  }

  /** Records when the server last answered, unless a later time is there. */
  saveLastOK(id: string, ts: number): void {
    this.sql.exec(
      `INSERT INTO last_ok (server_id, ts) VALUES (?, ?)
       ON CONFLICT (server_id) DO UPDATE SET ts = max(ts, excluded.ts)`,
      id, ts,
    );
  }

  /** The last day whose total is kept, if any. */
  rolledThrough(id: string): number | undefined {
    return this.sql.exec<{ day: number }>(`SELECT day FROM rolled WHERE server_id = ?`, id)[0]?.day;
  }

  /** The server's samples from from up to, not including, to, oldest first. */
  samples(id: string, from: number, to: number): Sample[] {
    return this.sql
      .exec<ProbeRow>(
        `SELECT vantage, ts, ok, latency_ms, err_class FROM probes
         WHERE server_id = ? AND ts >= ? AND ts < ? ORDER BY ts`,
        id, from, to,
      )
      .map(toSample);
  }

  /** The server's most recent sample, if it has one. */
  latest(id: string): Sample | undefined {
    const rows = this.sql.exec<ProbeRow>(
      `SELECT vantage, ts, ok, latency_ms, err_class FROM probes
       WHERE server_id = ? ORDER BY ts DESC LIMIT 1`,
      id,
    );
    return rows[0] ? toSample(rows[0]) : undefined;
  }

  /** When the server last answered a probe. It outlives retention. */
  lastOK(id: string): number | undefined {
    return this.sql.exec<{ ts: number }>(`SELECT ts FROM last_ok WHERE server_id = ?`, id)[0]?.ts;
  }

  /** Totals every day before today that has probes of the server and no total
   * yet, and notes that every day before today is closed. A day is totalled
   * once, after it ends, and a day with no probes gets no total: in the record
   * it stays a day without data. Only the days after the last closed one are
   * read. */
  rollup(id: string, today: number): void {
    const from = (this.rolledThrough(id) ?? -1) + 1;
    const days = this.sql
      .exec<{ day: number }>(
        // A Durable Object binds every number as REAL, which would make this a
        // fractional division: the casts keep the day a whole number however
        // the parameter arrives.
        `SELECT DISTINCT CAST(ts AS INTEGER) / CAST(? AS INTEGER) AS day FROM probes
         WHERE server_id = ? AND ts >= ? AND ts < ?
         AND CAST(ts AS INTEGER) / CAST(? AS INTEGER) NOT IN (SELECT day FROM daily WHERE server_id = ?)`,
        MS_PER_DAY, id, dayStart(from), dayStart(today), MS_PER_DAY, id,
      )
      .map((r) => Math.floor(r.day));
    for (const d of days) {
      const samples = this.samples(id, dayStart(d), dayStart(d + 1));
      const u = tally(samples);
      this.sql.exec(
        `INSERT INTO daily (server_id, day, up_minutes, observed_minutes, p50_ms) VALUES (?, ?, ?, ?, ?)`,
        id, d, u.up, u.observed, medianLatency(samples),
      );
    }
    this.sql.exec(
      `INSERT INTO rolled (server_id, day) VALUES (?, ?)
       ON CONFLICT (server_id) DO UPDATE SET day = max(day, excluded.day)`,
      id, today - 1,
    );
  }

  /** The server's day totals from from to to, both included. Days without a
   * total are left out. */
  totals(id: string, from: number, to: number): DayTotal[] {
    return this.sql
      .exec<{ day: number; up_minutes: number; observed_minutes: number; p50_ms: number }>(
        `SELECT day, up_minutes, observed_minutes, p50_ms FROM daily
         WHERE server_id = ? AND day >= ? AND day <= ? ORDER BY day`,
        id, from, to,
      )
      .map((r) => ({ day: r.day, uptime: { up: r.up_minutes, observed: r.observed_minutes }, p50Ms: r.p50_ms }));
  }

  /** Deletes the probes older than before. Roll up first, or the days it
   * deletes are never totalled. */
  prune(before: number): void {
    this.sql.exec(`DELETE FROM probes WHERE ts < ?`, before);
  }
}
