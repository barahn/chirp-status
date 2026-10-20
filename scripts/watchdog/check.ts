// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda
//
// What the watchdog decides, apart from what it fetches: whether the monitor
// is answering with fresh figures, whether the day's operational use is
// getting near a limit, and what that means for the issue that reports it.
// run.ts does the fetching. It is outside the Worker, on GitHub Actions, so
// it still sees the monitor when the monitor itself cannot run.

/** How old the newest probe may be. A round is every 30 s; a few missed ones
 * are a hiccup, this many a monitor that stopped. */
export const STALE_MS = 3 * 60 * 1000;

/** Daily limits for Durable Objects, reset at
 * 00:00 UTC. Past one, that kind of operation is refused until the reset. */
export const FREE_LIMITS = { rowsRead: 5_000_000, rowsWritten: 100_000, requests: 100_000 } as const;

/** How much of a limit is used before it is reported: early enough to act
 * on the day it happens. */
export const USAGE_WARN = 0.6;

/** One thing wrong. The key names the kind, so a problem reported once is not
 * reported again on every run while its figures change. */
export interface Problem {
  key: string;
  text: string;
}

/** What the API answered. status is 0 when it did not answer. */
export interface ApiReply {
  status: number;
  body: string;
  date: string | null;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** The problems with an answer from /v1/servers, at now on the runner's
 * clock. Ages are measured on the monitor's clock, from Date, when it sent
 * one. */
export function checkApi(r: ApiReply, now: number): Problem[] {
  if (r.status !== 200) {
    const said = r.body.trim().slice(0, 200);
    const what = r.status === 0 ? "did not answer" : `answered ${r.status}`;
    return [{ key: "api", text: `/v1/servers ${what}${said ? `: "${said}"` : ""}` }];
  }
  let servers: { last_checked?: string | null }[];
  try {
    const parsed = JSON.parse(r.body) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) throw new Error("no servers");
    servers = parsed.servers;
  } catch {
    return [{ key: "api", text: "/v1/servers answered 200 with something that is not a snapshot" }];
  }
  const at = r.date ? Date.parse(r.date) : NaN;
  const clock = Number.isNaN(at) ? now : at;
  const newest = Math.max(...servers.map((s) => (s.last_checked ? Date.parse(s.last_checked) : -Infinity)));
  if (!Number.isFinite(newest)) {
    return [{ key: "stale", text: "the monitor answers, but no server has been probed" }];
  }
  const age = clock - newest;
  if (age > STALE_MS) {
    return [{ key: "stale", text: `the newest probe is ${minutes(age)} old (more than ${minutes(STALE_MS)}): the rounds have stopped` }];
  }
  return [];
}

/** One day's use of the account's Durable Objects. */
export interface Usage {
  rowsRead: number;
  rowsWritten: number;
  requests: number;
}

const NAMES: Record<keyof Usage, string> = { rowsRead: "rows read", rowsWritten: "rows written", requests: "requests" };
const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** The figures past warnAt of their limit. The percentage is truncated, as
 * the page's are. */
export function checkUsage(u: Usage, limits: Usage = FREE_LIMITS, warnAt = USAGE_WARN): Problem[] {
  const out: Problem[] = [];
  for (const k of Object.keys(NAMES) as (keyof Usage)[]) {
    if (u[k] >= warnAt * limits[k]) {
      const pct = Math.floor((u[k] / limits[k]) * 100);
      out.push({ key: k, text: `${NAMES[k]} today: ${n(u[k])} of ${n(limits[k])} (${pct} %); operations may be throttled past limit` });
    }
  }
  return out;
}

/** The query for today's use, summed by parseUsage. Two datasets: rows come
 * from the periodic one, requests from the invocations one. */
export const USAGE_QUERY = `query Usage($account: string!, $day: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      periodic: durableObjectsPeriodicGroups(filter: { date: $day }, limit: 10000) {
        sum { rowsRead rowsWritten }
      }
      invocations: durableObjectsInvocationsAdaptiveGroups(filter: { date: $day }, limit: 10000) {
        sum { requests }
      }
    }
  }
}`;

interface UsageReply {
  data?: {
    viewer?: {
      accounts?: {
        periodic?: { sum?: { rowsRead?: number; rowsWritten?: number } }[];
        invocations?: { sum?: { requests?: number } }[];
      }[];
    };
  } | null;
  errors?: { message: string }[] | null;
}

/** Today's use from the GraphQL answer. An error is thrown, never read as
 * no use. */
export function parseUsage(reply: unknown): Usage {
  const r = reply as UsageReply;
  if (r.errors?.length) throw new Error(`GraphQL: ${r.errors.map((e) => e.message).join("; ")}`);
  const account = r.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("GraphQL: the answer has no account; check the account ID and the token's access");
  const sum = <T>(groups: T[] | undefined, f: (g: T) => number | undefined) =>
    (groups ?? []).reduce((acc, g) => acc + (f(g) ?? 0), 0);
  return {
    rowsRead: sum(account.periodic, (g) => g.sum?.rowsRead),
    rowsWritten: sum(account.periodic, (g) => g.sum?.rowsWritten),
    requests: sum(account.invocations, (g) => g.sum?.requests),
  };
}

/** The issue the watchdog keeps open while something is wrong. */
export interface OpenIssue {
  number: number;
  /** The problems last reported on it. */
  reported: string[];
}

export type Action =
  | { kind: "none" }
  | { kind: "open"; title: string; body: string }
  | { kind: "comment"; number: number; body: string }
  | { kind: "close"; number: number; body: string };

export const ISSUE_TITLE = "Watchdog: status.usechirp.app needs attention";

const MARKER = /<!-- watchdog: (\[[^\]]*\]) -->/g;

const report = (problems: Problem[]) =>
  problems.map((p) => `- ${p.text}`).join("\n") +
  `\n\n<!-- watchdog: ${JSON.stringify(problems.map((p) => p.key))} -->`;

/** The problems a body last reported, from its marker. */
export function reportedKeys(body: string): string[] {
  const all = [...body.matchAll(MARKER)];
  const last = all.at(-1);
  if (!last) return [];
  try {
    return JSON.parse(last[1]!) as string[];
  } catch {
    return [];
  }
}

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** What to do about problems, given the issue open, if any: open one, say
 * the problems changed, close it once all is well, or nothing. */
export function decide(problems: Problem[], open: OpenIssue | null): Action {
  if (problems.length === 0) {
    return open ? { kind: "close", number: open.number, body: "All is well again: the monitor answers with fresh figures and the day's use is under the limits." } : { kind: "none" };
  }
  const keys = problems.map((p) => p.key);
  if (!open) return { kind: "open", title: ISSUE_TITLE, body: `The watchdog found:\n\n${report(problems)}` };
  if (same(keys, open.reported)) return { kind: "none" };
  return { kind: "comment", number: open.number, body: `Now:\n\n${report(problems)}` };
}
