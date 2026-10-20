// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { type Uptime } from "./uptime";

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
  `CREATE TABLE IF NOT EXISTS daily (
    server_id        TEXT    NOT NULL,
    day              INTEGER NOT NULL, -- days since 1970-01-01, UTC
    up_minutes       INTEGER NOT NULL,
    observed_minutes INTEGER NOT NULL,
    p50_ms           INTEGER NOT NULL,
    PRIMARY KEY (server_id, day)
  )`,
  // What the monitor keeps in memory, one row per server, so an object taken
  // out of memory gets it back for a row. It is the only copy of the day in
  // course: single probes are not kept, since writing one on every round, with
  // its index, spent three times a day's write budget per server.
  `CREATE TABLE IF NOT EXISTS memory (
    server_id TEXT    PRIMARY KEY,
    state     TEXT    NOT NULL
  )`,
  // The last day whose total is in daily, so a day is closed once, by the
  // first round after it ends.
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

export class Store {
  constructor(private readonly sql: Sql) {
    for (const s of SCHEMA) sql.exec(s);
  }

  /** The server's state as the monitor last saved it, if it has one. */
  loadState(id: string): string | undefined {
    return this.sql.exec<{ state: string }>(`SELECT state FROM memory WHERE server_id = ?`, id)[0]?.state;
  }

  saveState(id: string, state: string): void {
    this.sql.exec(
      `INSERT INTO memory (server_id, state) VALUES (?, ?)
       ON CONFLICT (server_id) DO UPDATE SET state = excluded.state`,
      id, state,
    );
  }

  /** The last day whose total is kept, if any. */
  rolledThrough(id: string): number | undefined {
    return this.sql.exec<{ day: number }>(`SELECT day FROM rolled WHERE server_id = ?`, id)[0]?.day;
  }

  /** Records the totals of days that have ended and how far the server is
   * closed, together. A day already totalled keeps the total it has: a close
   * whose state was not saved afterwards is run again on the next round, and
   * must not write the day twice. */
  closeDays(id: string, totals: DayTotal[], through: number): void {
    this.sql.transaction(() => {
      for (const t of totals) {
        this.sql.exec(
          `INSERT INTO daily (server_id, day, up_minutes, observed_minutes, p50_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (server_id, day) DO NOTHING`,
          id, t.day, t.uptime.up, t.uptime.observed, t.p50Ms,
        );
      }
      this.sql.exec(
        `INSERT INTO rolled (server_id, day) VALUES (?, ?)
         ON CONFLICT (server_id) DO UPDATE SET day = max(day, excluded.day)`,
        id, through,
      );
    });
  }

  /** The server's day totals from from to to, both included. Days without a
   * total are left out. A Durable Object binds every number as REAL, so a day
   * comes back as one: it is made whole again here. */
  totals(id: string, from: number, to: number): DayTotal[] {
    return this.sql
      .exec<{ day: number; up_minutes: number; observed_minutes: number; p50_ms: number }>(
        `SELECT day, up_minutes, observed_minutes, p50_ms FROM daily
         WHERE server_id = ? AND day >= ? AND day <= ? ORDER BY day`,
        id, from, to,
      )
      .map((r) => ({
        day: Math.round(r.day),
        uptime: { up: r.up_minutes, observed: r.observed_minutes },
        p50Ms: r.p50_ms,
      }));
  }
}
