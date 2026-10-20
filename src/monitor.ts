// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// The monitor itself, apart from where it runs: a round of probes, the
// snapshot /v1/servers serves, and a server's history. The Durable Object in
// worker.ts is a thin layer over this, so the tests can drive all of it with
// a fake clock and a fake fetch.
//
// What the figures need is kept in memory and saved as one row per server,
// written once a round: a Durable Object on Cloudflare's free plan may read
// five million rows a day but write only a hundred thousand, and Cloudflare
// takes an object out of memory when it likes, in production all but between
// every request. So an object that comes back reads one row per server, and
// single probes are not kept at all -- a row per probe, with its index, cost
// three writes a round, and a day of them had to be deleted once retention
// was reached, which is another write each. A day that ends is totalled from
// what is in memory, which the row carries, and the total is all that is kept
// of it.

import { nicknameForURL, type Nickname } from "./folklore";
import { probe, type ProbeDeps } from "./probe";
import { RENAMES } from "./renames";
import { isNew, listing, type Kind, type Listing, type Server } from "./registry";
import { Store, dayOf, dayStart, dayString, type DayTotal } from "./store";
import {
  INTERVAL_MS, OFFLINE_AFTER, STALE_AFTER_MS, add, medianLatency, minuteOf, percent, record,
  tallyMinutes, verdict, type MinuteCounts, type Sample, type State, type Uptime,
} from "./uptime";

/** The longest history /v1/servers/{id}/history returns. */
export const MAX_HISTORY_DAYS = 90;

/** How many of a server's latest samples are kept for its verdict: enough
 * for OFFLINE_AFTER from each of a few vantage points. */
const RECENT = 4 * OFFLINE_AFTER;

export interface Window {
  up_minutes: number;
  observed_minutes: number;
  percent: number | null;
}

const window = (u: Uptime): Window => ({ up_minutes: u.up, observed_minutes: u.observed, percent: percent(u) });
const iso = (ms: number): string => new Date(ms).toISOString();

/** Latencies as samples, for medianLatency, which takes the probes a figure
 * is made of. A day's latencies are kept as numbers alone. */
const asSamples = (latencies: number[] = []): Sample[] =>
  latencies.map((latencyMs) => ({ vantage: "", at: 0, ok: true, latencyMs, err: "" }));

/** One server as /v1/servers reports it. */
export interface ServerStatus {
  id: string;
  /** A name from folklore, derived from the URL's host. Not unique and not a
   * key: it is there to be spoken, while the id is what the API is keyed by. */
  nickname?: Nickname;
  kind: Kind;
  url: string;
  operator: string;
  region?: string;
  behind_cdn: boolean;
  added: string;
  new: boolean;
  listing: Listing;
  state: State;
  last_checked: string | null;
  last_error?: string;
  latency_ms: number | null;
  last_ok: string | null;
  uptime: { "24h": Window; "30d": Window; "90d": Window };
}

/** What /v1/servers returns. */
export interface Snapshot {
  generated_at: string;
  vantage: string;
  interval_seconds: number;
  servers: ServerStatus[];
}

/** One day as the history reports it. */
export interface DayStatus extends Window {
  day: string;
  p50_ms: number | null;
}

/** What is kept in memory of one server. */
interface Mem {
  /** Its probes by minute, from yesterday's start: the last 24 hours and
   * today are counted from these. */
  minutes: Map<number, MinuteCounts>;
  /** Its successful probes' latencies, by day, for today and yesterday. */
  latencies: Map<number, number[]>;
  /** Its latest samples, oldest first, for its verdict. */
  recent: Sample[];
  lastOK?: number;
  /** The totals of the days before today, the last MAX_HISTORY_DAYS. */
  closed: Map<number, DayTotal>;
  /** The last day closed: its total, and every one before, are in storage. */
  rolledThrough: number;
}

/** A server's memory as one string, for its row in storage. */
function encode(m: Mem): string {
  return JSON.stringify({
    minutes: [...m.minutes].map(([minute, byVantage]) => [minute, [...byVantage].map(([v, c]) => [v, c.ok, c.failed])]),
    latencies: [...m.latencies],
    recent: m.recent,
    lastOK: m.lastOK ?? null,
    closed: [...m.closed.values()].map((t) => [t.day, t.uptime.up, t.uptime.observed, t.p50Ms]),
    rolledThrough: m.rolledThrough,
  });
}

function decode(state: string): Mem {
  const o = JSON.parse(state) as {
    minutes: [number, [string, number, number][]][];
    latencies: [number, number[]][];
    recent: Sample[];
    lastOK: number | null;
    closed: [number, number, number, number][];
    rolledThrough: number;
  };
  return {
    minutes: new Map(o.minutes.map(([minute, vs]) => [minute, new Map(vs.map(([v, ok, failed]) => [v, { ok, failed }]))])),
    latencies: new Map(o.latencies),
    recent: o.recent,
    lastOK: o.lastOK ?? undefined,
    closed: new Map(o.closed.map(([day, up, observed, p50Ms]) => [day, { day, uptime: { up, observed }, p50Ms }])),
    rolledThrough: o.rolledThrough,
  };
}

export class Monitor {
  private readonly mem = new Map<string, Mem>();
  private renamesApplied = false;

  constructor(
    private readonly store: Store,
    private readonly vantage: string,
    private readonly deps: ProbeDeps,
  ) {}

  /** A server's memory: its saved row, or a fresh start when there is none to
   * read. */
  private memory(id: string): Mem {
    let m = this.mem.get(id);
    if (m) return m;
    const saved = this.store.loadState(id);
    if (saved !== undefined) {
      try {
        m = decode(saved);
      } catch (e) {
        // A row that will not decode -- written by a version whose encoding
        // this one does not know, or truncated -- must not stop the rounds.
        // Read crudely it threw here, out of the round, and out of the alarm
        // that runs the rounds, which is how a monitor stops for good. The day
        // in course is lost either way; starting afresh writes a row this
        // version can read and keeps the record going.
        console.error(`chirp-status: ${id}: state unreadable, starting afresh: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    if (m === undefined) {
      // The first time ever, or after a row that is gone or unreadable: there
      // is nothing to work the day in course out from, so it starts empty,
      // with the days already closed.
      const today = dayOf(this.deps.now());
      m = { minutes: new Map(), latencies: new Map(), recent: [], closed: new Map(), rolledThrough: this.store.rolledThrough(id) ?? -1 };
      for (const t of this.store.totals(id, today - MAX_HISTORY_DAYS, today - 1)) m.closed.set(t.day, t);
      this.store.saveState(id, encode(m));
    }
    this.mem.set(id, m);
    return m;
  }

  private remember(m: Mem, s: Sample): void {
    record(m.minutes, s);
    if (s.ok) {
      const day = dayOf(s.at);
      let list = m.latencies.get(day);
      if (!list) m.latencies.set(day, (list = []));
      list.push(s.latencyMs);
      m.lastOK = s.at;
    }
    m.recent.push(s);
    if (m.recent.length > RECENT) m.recent.splice(0, m.recent.length - RECENT);
  }

  /** Probes every server once, all at the same time, records what it saw, and
   * closes the days that have ended. */
  async round(servers: Server[]): Promise<void> {
    this.applyRenames();
    const at = this.deps.now();
    const results = await Promise.all(servers.map((s) => probe(s.url, this.deps)));
    const today = dayOf(at);
    servers.forEach((srv, i) => {
      const m = this.memory(srv.id);
      const s: Sample = { vantage: this.vantage, at, ...results[i]! };
      this.remember(m, s);
      // Once a day, the days before today are closed; whether they are is
      // in the saved state, so an object back in memory does not do it again.
      if (m.rolledThrough < today - 1) this.closeDays(srv.id, m, today);
      this.store.saveState(srv.id, encode(m));
    });
  }

  /** Moves the record of every server that was renamed, once per object in
   * memory rather than once per round: a round that read five rows per
   * declared rename would spend the reads a day allows on lines that have
   * nothing left to move. An object Cloudflare brings back does it again,
   * which is how a rename declared while the object was away is applied.
   *
   * A rename that refuses is logged and the others still run: one bad line
   * must not stop the rounds, and the server keeps its record under the old
   * id until the line is fixed. */
  private applyRenames(): void {
    if (this.renamesApplied) return;
    this.renamesApplied = true;
    for (const r of RENAMES) {
      try {
        if (this.rename(r.from, r.to)) {
          console.log(`chirp-status: moved the record of ${r.from} to ${r.to}`);
        }
      } catch (e) {
        console.error(`chirp-status: rename ${r.from} -> ${r.to}: ${(e as Error).message}`);
      }
    }
  }

  /** Moves one server's record, in storage and in memory, to a new id.
   * Returns whether there was anything to move. */
  rename(from: string, to: string): boolean {
    if (from === to) return false;
    if (!this.store.has(from)) return false;
    if (this.store.has(to)) {
      this.merge(from, to);
      return true;
    }
    const moved = this.store.rename(from, to);
    // Memory is dropped either way, not moved: a Mem holds nothing keyed by
    // id, but the entry under the old id must not answer for a server that
    // no longer has that id, and the entry under the new id has to be built
    // from the rows that have just arrived.
    this.mem.delete(from);
    this.mem.delete(to);
    return moved;
  }

  /** Merges `from`'s record into `to` when both have one, and drops `from`.
   * This handles the case where `from` was moved to `to`, but `from` was
   * probed again before the registry updated. */
  private merge(from: string, to: string): void {
    this.store.copyTotals(from, to);
    const fromState = this.store.loadState(from);
    const toState = this.store.loadState(to);
    if (fromState && !toState) {
      this.store.saveState(to, fromState);
    } else if (fromState && toState) {
      try {
        const fromMem = decode(fromState);
        const toMem = decode(toState);
        for (const [minute, vs] of fromMem.minutes) {
          const targetVs = toMem.minutes.get(minute);
          if (!targetVs) {
            toMem.minutes.set(minute, vs);
          } else {
            for (const [v, c] of vs) {
              const tc = targetVs.get(v);
              if (!tc) targetVs.set(v, { ok: c.ok, failed: c.failed });
              else {
                tc.ok += c.ok;
                tc.failed += c.failed;
              }
            }
          }
        }
        for (const [day, lats] of fromMem.latencies) {
          const targetLats = toMem.latencies.get(day);
          if (!targetLats) toMem.latencies.set(day, [...lats]);
          else targetLats.push(...lats);
        }
        toMem.recent = [...toMem.recent, ...fromMem.recent]
          .sort((a, b) => a.at - b.at)
          .slice(-RECENT);
        if (fromMem.lastOK !== undefined) {
          toMem.lastOK = Math.max(toMem.lastOK ?? 0, fromMem.lastOK);
        }
        for (const [day, t] of fromMem.closed) {
          if (!toMem.closed.has(day)) toMem.closed.set(day, t);
        }
        toMem.rolledThrough = Math.max(toMem.rolledThrough, fromMem.rolledThrough);
        this.store.saveState(to, encode(toMem));
      } catch (e) {
        console.error(`chirp-status: merging state ${from} -> ${to}: ${(e as Error).message}`);
      }
    }
    this.store.drop(from);
    this.mem.delete(from);
    this.mem.delete(to);
  }

  /** Totals the days that have ended from what is in memory, keeps those
   * totals, and forgets what memory no longer needs. A day nobody probed gets
   * no total: in the record it stays a day without data. Only the last
   * MAX_HISTORY_DAYS are considered, since no older day is served and memory
   * never reaches that far back anyway. */
  private closeDays(id: string, m: Mem, today: number): void {
    const totals: DayTotal[] = [];
    for (let d = Math.max(m.rolledThrough + 1, today - MAX_HISTORY_DAYS); d < today; d++) {
      const uptime = tallyMinutes(m.minutes, minuteOf(dayStart(d)), minuteOf(dayStart(d + 1)));
      if (uptime.observed === 0) continue;
      totals.push({ day: d, uptime, p50Ms: medianLatency(asSamples(m.latencies.get(d))) });
    }
    this.store.closeDays(id, totals, today - 1);
    for (const t of totals) m.closed.set(t.day, t);
    m.rolledThrough = today - 1;
    for (const d of m.closed.keys()) if (d < today - MAX_HISTORY_DAYS) m.closed.delete(d);
    const keepFrom = minuteOf(dayStart(today - 1));
    for (const minute of m.minutes.keys()) if (minute < keepFrom) m.minutes.delete(minute);
    for (const d of m.latencies.keys()) if (d < today - 1) m.latencies.delete(d);
  }

  /** Every server's status now, from memory.
   *
   * The 24-hour figure counts the last 1,440 whole minutes. The 30- and 90-day
   * figures count whole UTC days, today's minutes so far included, so they
   * move at midnight: they are the sum of the days the history shows. */
  status(servers: Server[]): Snapshot {
    const now = this.deps.now();
    const minute = minuteOf(now);
    const today = dayOf(now);
    return {
      generated_at: iso(now),
      vantage: this.vantage,
      interval_seconds: INTERVAL_MS / 1000,
      servers: servers.map((s) => {
        const m = this.memory(s.id);
        const last = m.recent.at(-1);
        const recent = m.recent.filter((r) => r.at >= now - STALE_AFTER_MS - OFFLINE_AFTER * INTERVAL_MS);
        const days = this.history(s.id, today, MAX_HISTORY_DAYS, now - (now % 60_000));
        const nickname = nicknameForURL(s.url);
        let u30: Uptime = { up: 0, observed: 0 };
        let u90: Uptime = { up: 0, observed: 0 };
        days.forEach((d, i) => {
          u90 = add(u90, d.uptime);
          if (i >= days.length - 30) u30 = add(u30, d.uptime);
        });
        return {
          id: s.id,
          ...(nickname ? { nickname } : {}),
          kind: s.kind,
          url: s.url,
          operator: s.operator,
          ...(s.region ? { region: s.region } : {}),
          behind_cdn: s.behind_cdn ?? false,
          added: s.added,
          new: isNew(s, now),
          listing: listing(s),
          state: verdict(recent, now),
          last_checked: last ? iso(last.at) : null,
          ...(last?.err ? { last_error: last.err } : {}),
          latency_ms: last?.ok ? last.latencyMs : null,
          last_ok: m.lastOK !== undefined ? iso(m.lastOK) : null,
          uptime: {
            "24h": window(tallyMinutes(m.minutes, minute - 24 * 60, minute)),
            "30d": window(u30),
            "90d": window(u90),
          },
        };
      }),
    };
  }

  /** n days up to today, oldest first, one entry for every day whether or not
   * it has data. Today is counted from memory, up to until. n comes from a
   * request: anything but 1 to MAX_HISTORY_DAYS is refused here, whatever the
   * caller checked. */
  history(id: string, today: number, n: number, until: number): DayTotal[] {
    if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_DAYS) {
      throw new RangeError(`a history of ${n} days: want 1 to ${MAX_HISTORY_DAYS}`);
    }
    const m = this.memory(id);
    const from = today - (n - 1);
    const todays: DayTotal = {
      day: today,
      uptime: tallyMinutes(m.minutes, minuteOf(dayStart(today)), minuteOf(until)),
      p50Ms: medianLatency(asSamples(m.latencies.get(today))),
    };
    const out: DayTotal[] = [];
    for (let d = from; d <= today; d++) {
      out.push(d === today ? todays : (m.closed.get(d) ?? { day: d, uptime: { up: 0, observed: 0 }, p50Ms: 0 }));
    }
    return out;
  }

  /** A server's history as the API reports it. */
  historyStatus(id: string, n: number): DayStatus[] {
    const now = this.deps.now();
    return this.history(id, dayOf(now), n, now - (now % 60_000)).map((d) => ({
      day: dayString(d.day),
      ...window(d.uptime),
      p50_ms: d.uptime.up > 0 ? d.p50Ms : null,
    }));
  }
}
