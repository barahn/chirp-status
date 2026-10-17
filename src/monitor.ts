// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// The monitor itself, apart from where it runs: a round of probes, the
// snapshot /v1/servers serves, and a server's history. The Durable Object in
// worker.ts is a thin layer over this, so the tests can drive all of it with
// a fake clock and a fake fetch.
//
// What the figures need is kept in memory, and storage is read only to start
// and once a day: a Durable Object on Cloudflare's free plan may read five
// million rows a day, and working out the figures from storage on every
// request spent that in a day with a page polling it. Storage is the record;
// memory is what the API answers from.

import { probe, type ProbeDeps } from "./probe";
import { isNew, listing, type Kind, type Listing, type Server } from "./registry";
import { RETENTION_MS, Store, dayOf, dayStart, dayString, type DayTotal } from "./store";
import {
  INTERVAL_MS, OFFLINE_AFTER, STALE_AFTER_MS, add, medianLatency, minuteOf, percent, record,
  tallyMinutes, verdict, type MinuteCounts, type Sample, type State, type Uptime,
} from "./uptime";

/** The longest history /v1/servers/{id}/history returns. */
export const MAX_HISTORY_DAYS = 90;

/** How often, at most, when a server last answered is written while it keeps
 * answering. When it stops, it is written at once. */
export const LAST_OK_EVERY_MS = 10 * 60 * 1000;

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

/** One server as /v1/servers reports it. */
export interface ServerStatus {
  id: string;
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
  lastOKSaved?: number;
  /** The totals of the days before today, the last MAX_HISTORY_DAYS. */
  closed: Map<number, DayTotal>;
}

export class Monitor {
  private readonly mem = new Map<string, Mem>();
  private rolled = -1;

  constructor(
    private readonly store: Store,
    private readonly vantage: string,
    private readonly deps: ProbeDeps,
  ) {}

  /** A server's memory, read from storage the first time it is asked for. */
  private memory(id: string): Mem {
    let m = this.mem.get(id);
    if (m) return m;
    const now = this.deps.now();
    const today = dayOf(now);
    m = { minutes: new Map(), latencies: new Map(), recent: [], closed: new Map() };
    for (const s of this.store.samples(id, dayStart(today - 1), now + 1)) this.remember(m, s);
    m.lastOK = Math.max(m.lastOK ?? -Infinity, this.store.lastOK(id) ?? -Infinity);
    if (!Number.isFinite(m.lastOK)) m.lastOK = undefined;
    m.lastOKSaved = m.lastOK;
    for (const t of this.store.totals(id, today - MAX_HISTORY_DAYS, today - 1)) m.closed.set(t.day, t);
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

  /** Probes every server once, all at the same time, records what it saw,
   * closes the days that have ended, and drops probes past retention. */
  async round(servers: Server[]): Promise<void> {
    const at = this.deps.now();
    const results = await Promise.all(servers.map((s) => probe(s.url, this.deps)));
    servers.forEach((srv, i) => {
      const m = this.memory(srv.id);
      const s: Sample = { vantage: this.vantage, at, ...results[i]! };
      const wasUp = m.recent.at(-1)?.ok ?? false;
      this.store.add(srv.id, s);
      this.remember(m, s);
      // When it last answered matters most once it stops: written then, and
      // otherwise now and again.
      const stopped = wasUp && !s.ok;
      if (m.lastOK !== undefined && m.lastOK !== m.lastOKSaved &&
          (stopped || at - (m.lastOKSaved ?? -Infinity) >= LAST_OK_EVERY_MS)) {
        this.store.saveLastOK(srv.id, m.lastOK);
        m.lastOKSaved = m.lastOK;
      }
    });
    const today = dayOf(at);
    if (today !== this.rolled) {
      for (const srv of servers) this.closeDays(srv.id, today);
      this.store.prune(at - RETENTION_MS);
      this.rolled = today;
    }
  }

  /** Totals the days before today in storage, takes their totals into
   * memory, and forgets what memory no longer needs. */
  private closeDays(id: string, today: number): void {
    const m = this.memory(id);
    this.store.rollup(id, today);
    for (const t of this.store.totals(id, today - MAX_HISTORY_DAYS, today - 1)) m.closed.set(t.day, t);
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
        let u30: Uptime = { up: 0, observed: 0 };
        let u90: Uptime = { up: 0, observed: 0 };
        days.forEach((d, i) => {
          u90 = add(u90, d.uptime);
          if (i >= days.length - 30) u30 = add(u30, d.uptime);
        });
        return {
          id: s.id,
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
      p50Ms: medianLatency((m.latencies.get(today) ?? []).map((latencyMs) => ({ vantage: "", at: 0, ok: true, latencyMs, err: "" }))),
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
