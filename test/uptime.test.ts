// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import { medianLatency, percent, tally, verdict, type Sample } from "../src/uptime";

const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const S = 1000;
const MIN = 60 * S;
const at = (vantage: string, d: number, ok: boolean): Sample => ({ vantage, at: t0 + d, ok, latencyMs: 0, err: "" });

describe("tally", () => {
  test("counts only minutes that were probed", () => {
    // Minutes 0 and 1 probed, 2 to 9 nobody probed, 10 probed and down.
    const samples = [
      at("a", 0, true), at("a", 30 * S, true),
      at("a", MIN, true), at("a", 90 * S, true),
      at("a", 10 * MIN, false), at("a", 10 * MIN + 30 * S, false),
    ];
    expect(tally(samples)).toEqual({ up: 2, observed: 3 });
  });

  test("a tie is down", () => {
    expect(tally([at("a", 0, true), at("a", 30 * S, false)]).up).toBe(0);
    expect(tally([at("a", 0, true), at("b", 0, false)])).toEqual({ up: 0, observed: 1 });
  });

  test("most vantage points decide", () => {
    expect(tally([at("a", 0, true), at("b", 0, true), at("c", 0, false)])).toEqual({ up: 1, observed: 1 });
    expect(tally([at("a", 0, false), at("b", 0, false), at("c", 0, true)])).toEqual({ up: 0, observed: 1 });
  });
});

describe("percent", () => {
  test("is cut, not rounded", () => {
    expect(percent({ up: 0, observed: 0 })).toBeNull();
    // 99.99993 % would round to 100.
    expect(percent({ up: 1439999, observed: 1440000 })).toBe(99.999);
    expect(percent({ up: 7, observed: 7 })).toBe(100);
  });
});

describe("verdict", () => {
  const now = t0 + 2 * MIN;
  const stale = 90 * S;
  const cases: [string, Sample[], ReturnType<typeof verdict>][] = [
    ["never probed", [], "unknown"],
    ["newest probe too old", [at("a", 0, true)], "unknown"],
    ["latest ok after failures", [at("a", 30 * S, false), at("a", 60 * S, false), at("a", 90 * S, true)], "up"],
    ["two failures", [at("a", 30 * S, true), at("a", 60 * S, false), at("a", 90 * S, false)], "failing"],
    ["three failures", [at("a", 30 * S, false), at("a", 60 * S, false), at("a", 90 * S, false)], "offline"],
    ["only one probe so far, failed", [at("a", 90 * S, false)], "failing"],
    ["vantage points disagree", [
      at("a", 90 * S, true),
      at("b", 30 * S, false), at("b", 60 * S, false), at("b", 90 * S, false),
    ], "failing"],
    ["a stale vantage point is not asked", [
      at("a", 0, true),
      at("b", 30 * S, false), at("b", 60 * S, false), at("b", 90 * S, false),
    ], "offline"],
  ];
  for (const [name, samples, want] of cases) {
    test(name, () => expect(verdict(samples, now, stale)).toBe(want));
  }
});

test("median latency ignores failures", () => {
  const ss: Sample[] = [
    { vantage: "a", at: 0, ok: true, latencyMs: 30, err: "" },
    { vantage: "a", at: 0, ok: true, latencyMs: 10, err: "" },
    { vantage: "a", at: 0, ok: false, latencyMs: 5000, err: "timeout" },
    { vantage: "a", at: 0, ok: true, latencyMs: 20, err: "" },
  ];
  expect(medianLatency(ss)).toBe(20);
  expect(medianLatency(ss.slice(2, 3))).toBe(0);
});
