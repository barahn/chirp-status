// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// How probes become figures. Every figure comes from probes made from outside;
// a minute nobody probed is no data, never up and never down.

/** How often every server is probed. */
export const INTERVAL_MS = 30_000;

/** How many failed probes in a row make a server off-line: about 90 s at the
 * interval, the rule the relay's own health check uses. */
export const OFFLINE_AFTER = 3;

/** How old a vantage point's newest probe may be and still say what a server
 * is doing now: three missed rounds. */
export const STALE_AFTER_MS = 3 * INTERVAL_MS;

/** One probe of one server from one vantage point. */
export interface Sample {
  vantage: string;
  /** Unix milliseconds. */
  at: number;
  ok: boolean;
  latencyMs: number;
  err: string;
}

/** A count of minutes. A minute nobody probed is in neither count. */
export interface Uptime {
  up: number;
  observed: number;
}

export const add = (a: Uptime, b: Uptime): Uptime => ({ up: a.up + b.up, observed: a.observed + b.observed });

/** The share of observed minutes that were up, or null when none was
 * observed. Cut, never rounded, at three decimals, so it reads 100 only when
 * every observed minute was up. */
export function percent(u: Uptime): number | null {
  if (u.observed === 0) return null;
  return Math.floor((u.up * 100_000) / u.observed) / 1000;
}

/** Counts the minutes samples cover. A vantage point succeeded in a minute
 * when more than half its probes in that minute succeeded, and the minute was
 * up when more than half the vantage points that probed in it succeeded. A tie
 * is down: "most" means more than half, at both levels. */
export function tally(samples: Iterable<Sample>): Uptime {
  const minutes = new Map<number, Map<string, { ok: number; failed: number }>>();
  for (const s of samples) {
    const m = Math.floor(s.at / 60_000);
    let byVantage = minutes.get(m);
    if (!byVantage) minutes.set(m, (byVantage = new Map()));
    let c = byVantage.get(s.vantage);
    if (!c) byVantage.set(s.vantage, (c = { ok: 0, failed: 0 }));
    if (s.ok) c.ok++;
    else c.failed++;
  }
  const u: Uptime = { up: 0, observed: 0 };
  for (const byVantage of minutes.values()) {
    let up = 0;
    for (const c of byVantage.values()) if (c.ok > c.failed) up++;
    u.observed++;
    if (up * 2 > byVantage.size) u.up++;
  }
  return u;
}

/** The median latency of the successful samples, or 0 when none succeeded. */
export function medianLatency(samples: Iterable<Sample>): number {
  const ls = [...samples].filter((s) => s.ok).map((s) => s.latencyMs);
  if (ls.length === 0) return 0;
  ls.sort((a, b) => a - b);
  const mid = ls.length >> 1;
  return ls.length % 2 === 1 ? ls[mid]! : Math.floor((ls[mid - 1]! + ls[mid]!) / 2);
}

/** What a server is doing now. */
export type State = "unknown" | "up" | "failing" | "offline";

/** What a server is doing at now from its recent samples. Each vantage point
 * that probed it within staleAfter judges it by its own probes; the server is
 * up or off-line when most of them say so, and failing when they disagree. */
export function verdict(samples: Iterable<Sample>, now: number, staleAfter = STALE_AFTER_MS): State {
  const byVantage = new Map<string, Sample[]>();
  for (const s of samples) {
    let list = byVantage.get(s.vantage);
    if (!list) byVantage.set(s.vantage, (list = []));
    list.push(s);
  }
  let fresh = 0;
  let up = 0;
  let offline = 0;
  for (const ss of byVantage.values()) {
    ss.sort((a, b) => a.at - b.at);
    const last = ss[ss.length - 1]!;
    if (now - last.at > staleAfter) continue;
    fresh++;
    if (last.ok) up++;
    else if (ss.length >= OFFLINE_AFTER && ss.slice(-OFFLINE_AFTER).every((s) => !s.ok)) offline++;
  }
  if (fresh === 0) return "unknown";
  if (up * 2 > fresh) return "up";
  if (offline * 2 > fresh) return "offline";
  return "failing";
}
