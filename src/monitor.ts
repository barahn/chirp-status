// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// The monitor itself, apart from where it runs: a round of probes, the
// snapshot /v1/servers serves, and a server's history. The Durable Object in
// worker.ts is a thin layer over this, so the tests can drive all of it with
// a fake clock and a fake fetch.

import { probe, type ProbeDeps } from "./probe";
import { isNew, listing, type Kind, type Listing, type Server } from "./registry";
import { RETENTION_MS, Store, dayOf, dayStart, dayString, type DayTotal } from "./store";
import {
  INTERVAL_MS, OFFLINE_AFTER, STALE_AFTER_MS, add, medianLatency, percent, tally, verdict,
  type State, type Uptime,
} from "./uptime";

/** The longest history /v1/servers/{id}/history returns. */
export const MAX_HISTORY_DAYS = 90;

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

export class Monitor {
  private rolled = -1;

  constructor(
    private readonly store: Store,
    private readonly vantage: string,
    private readonly deps: ProbeDeps,
  ) {}

  /** Probes every server once, all at the same time, records what it saw,
   * closes the days that have ended, and drops probes past retention. */
  async round(servers: Server[]): Promise<void> {
    const at = this.deps.now();
    const results = await Promise.all(servers.map((s) => probe(s.url, this.deps)));
    servers.forEach((s, i) => this.store.add(s.id, { vantage: this.vantage, at, ...results[i]! }));
    const today = dayOf(at);
    if (today !== this.rolled) {
      for (const s of servers) this.store.rollup(s.id, today);
      this.store.prune(at - RETENTION_MS);
      this.rolled = today;
    }
  }

  /** Every server's status now.
   *
   * The 24-hour figure counts the last 1,440 whole minutes. The 30- and 90-day
   * figures count whole UTC days, today's minutes so far included, so they
   * move at midnight: they are the sum of the days the history shows. */
  status(servers: Server[]): Snapshot {
    const now = this.deps.now();
    const minute = now - (now % 60_000);
    const today = dayOf(now);
    return {
      generated_at: iso(now),
      vantage: this.vantage,
      interval_seconds: INTERVAL_MS / 1000,
      servers: servers.map((s) => {
        const recent = this.store.samples(s.id, now - STALE_AFTER_MS - OFFLINE_AFTER * INTERVAL_MS, now + 1);
        const last = this.store.latest(s.id);
        const lastOK = this.store.lastOK(s.id);
        const day = tally(this.store.samples(s.id, minute - 24 * 60 * 60 * 1000, minute));
        const days = this.history(s.id, today, MAX_HISTORY_DAYS, minute);
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
          last_ok: lastOK !== undefined ? iso(lastOK) : null,
          uptime: { "24h": window(day), "30d": window(u30), "90d": window(u90) },
        };
      }),
    };
  }

  /** n days up to today, oldest first, one entry for every day whether or not
   * it has data. Today is counted from the probes, up to until. n comes from a
   * request: anything but 1 to MAX_HISTORY_DAYS is refused here, whatever the
   * caller checked. */
  history(id: string, today: number, n: number, until: number): DayTotal[] {
    if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_DAYS) {
      throw new RangeError(`a history of ${n} days: want 1 to ${MAX_HISTORY_DAYS}`);
    }
    const from = today - (n - 1);
    const byDay = new Map(this.store.totals(id, from, today - 1).map((t) => [t.day, t]));
    const samples = this.store.samples(id, dayStart(today), until);
    byDay.set(today, { day: today, uptime: tally(samples), p50Ms: medianLatency(samples) });
    const out: DayTotal[] = [];
    for (let d = from; d <= today; d++) out.push(byDay.get(d) ?? { day: d, uptime: { up: 0, observed: 0 }, p50Ms: 0 });
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
