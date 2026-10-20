// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import {
  FREE_LIMITS,
  STALE_MS,
  checkApi,
  checkUsage,
  decide,
  parseUsage,
  reportedKeys,
  type Problem,
} from "../scripts/watchdog/check";

const now = Date.UTC(2026, 9, 20, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const snapshot = (lastChecked: (string | null)[]) =>
  JSON.stringify({
    generated_at: iso(now),
    vantage: "Cloudflare",
    interval_seconds: 30,
    servers: lastChecked.map((c, i) => ({ id: `s${i}`, state: "up", last_checked: c })),
  });

const keys = (ps: Problem[]) => ps.map((p) => p.key);

describe("the API", () => {
  test("a fresh answer is no problem", () => {
    const body = snapshot([iso(now - 20_000), iso(now - 40_000)]);
    expect(checkApi({ status: 200, body, date: new Date(now).toUTCString() }, now)).toEqual([]);
  });

  test("an answer other than 200 is a problem, the monitor's own text quoted", () => {
    const ps = checkApi({ status: 503, body: "the monitor is not answering\n", date: null }, now);
    expect(keys(ps)).toEqual(["api"]);
    expect(ps[0]!.text).toContain("503");
    expect(ps[0]!.text).toContain("the monitor is not answering");
  });

  test("no answer at all is a problem", () => {
    expect(keys(checkApi({ status: 0, body: "fetch failed", date: null }, now))).toEqual(["api"]);
  });

  test("a body that is not a snapshot is a problem", () => {
    expect(keys(checkApi({ status: 200, body: "<html>", date: null }, now))).toEqual(["api"]);
    expect(keys(checkApi({ status: 200, body: "{}", date: null }, now))).toEqual(["api"]);
  });

  test("rounds that stopped are a problem even when the API answers", () => {
    const ps = checkApi({ status: 200, body: snapshot([iso(now - STALE_MS - 1)]), date: null }, now);
    expect(keys(ps)).toEqual(["stale"]);
    expect(ps[0]!.text).toContain("3 min");
  });

  test("only the newest probe counts: one server just added and not probed yet is fine", () => {
    expect(checkApi({ status: 200, body: snapshot([iso(now - 10_000), null]), date: null }, now)).toEqual([]);
  });

  test("no server probed at all is a problem", () => {
    expect(keys(checkApi({ status: 200, body: snapshot([null]), date: null }, now))).toEqual(["stale"]);
    expect(keys(checkApi({ status: 200, body: snapshot([]), date: null }, now))).toEqual(["stale"]);
  });

  test("age is measured on the monitor's clock, the Date it answered with", () => {
    // The runner's clock is ahead; the monitor's says the probe is recent.
    const monitorNow = now - 10 * 60_000;
    const body = snapshot([iso(monitorNow - 20_000)]);
    expect(checkApi({ status: 200, body, date: new Date(monitorNow).toUTCString() }, now)).toEqual([]);
  });
});

describe("daily quota usage", () => {
  test("well under the limits is no problem", () => {
    expect(checkUsage({ rowsRead: 30_000, rowsWritten: 9_000, requests: 3_500 })).toEqual([]);
  });

  test("each figure past 60 % of its limit is a problem of its own", () => {
    const ps = checkUsage({
      rowsRead: 0.6 * FREE_LIMITS.rowsRead,
      rowsWritten: 0.6 * FREE_LIMITS.rowsWritten - 1,
      requests: FREE_LIMITS.requests,
    });
    expect(keys(ps)).toEqual(["rowsRead", "requests"]);
    expect(ps[0]!.text).toContain("3,000,000 of 5,000,000");
    expect(ps[0]!.text).toContain("60 %");
    expect(ps[1]!.text).toContain("100 %");
  });

  test("the GraphQL answer is summed over every group", () => {
    const u = parseUsage({
      data: {
        viewer: {
          accounts: [{
            periodic: [{ sum: { rowsRead: 10, rowsWritten: 2 } }, { sum: { rowsRead: 5, rowsWritten: 1 } }],
            invocations: [{ sum: { requests: 7 } }, { sum: { requests: 3 } }],
          }],
        },
      },
    });
    expect(u).toEqual({ rowsRead: 15, rowsWritten: 3, requests: 10 });
  });

  test("a day with no groups yet is zero", () => {
    expect(parseUsage({ data: { viewer: { accounts: [{ periodic: [], invocations: [] }] } } }))
      .toEqual({ rowsRead: 0, rowsWritten: 0, requests: 0 });
  });

  test("GraphQL errors are thrown with their messages, not read as zero", () => {
    expect(() => parseUsage({ data: null, errors: [{ message: "unknown field rowsRead" }] })).toThrow("unknown field rowsRead");
    expect(() => parseUsage({ data: { viewer: { accounts: [] } } })).toThrow("account");
  });
});

describe("what to do on the issue", () => {
  const down: Problem[] = [{ key: "api", text: "503" }];

  test("nothing wrong and no issue open: nothing", () => {
    expect(decide([], null).kind).toBe("none");
  });

  test("a problem and no issue open: open one", () => {
    const a = decide(down, null);
    expect(a.kind).toBe("open");
    if (a.kind === "open") {
      expect(a.title).toContain("status.usechirp.app");
      expect(reportedKeys(a.body)).toEqual(["api"]);
    }
  });

  test("the same problems already reported: nothing, so no comment every five minutes", () => {
    expect(decide([{ key: "api", text: "503 again, other words" }], { number: 4, reported: ["api"] }).kind).toBe("none");
  });

  test("other problems than the ones reported: a comment", () => {
    const a = decide([{ key: "stale", text: "rounds stopped" }], { number: 4, reported: ["api"] });
    expect(a.kind).toBe("comment");
    if (a.kind === "comment") expect(reportedKeys(a.body)).toEqual(["stale"]);
  });

  test("nothing wrong and an issue open: close it", () => {
    const a = decide([], { number: 4, reported: ["api"] });
    expect(a.kind).toBe("close");
  });

  test("a body with no marker reports nothing", () => {
    expect(reportedKeys("written by hand")).toEqual([]);
  });
});
