// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// A Durable Object binds every JavaScript number as REAL. In production, the
// day a probe fell on, ts / 86400000, came out a fraction, closing a day wrote
// its first total and then failed on the next, and the failure came back on
// every round, re-reading every probe: day 17 stayed without a total, and the
// reads went towards the free plan's limit.

import { expect, test } from "bun:test";
import { Monitor } from "../src/monitor";
import { parseServers } from "../src/registry";
import { Store, dayOf, dayStart } from "../src/store";
import { realBindingSql } from "./sql";

const servers = parseServers({
  servers: [{ id: "n1", kind: "node", url: "https://n1.example.org", operator: "T", github: "t", behind_cdn: false, added: "2026-10-15" }],
});

test("days close when numbers are bound as REAL, as a Durable Object binds them", async () => {
  const store = new Store(realBindingSql());
  const d16 = dayOf(Date.UTC(2026, 9, 16));
  const fill = (from: number, to: number) => {
    for (let at = from; at < to; at += 30_000) store.add("n1", { vantage: "v", at, ok: true, latencyMs: 20, err: "" });
  };
  fill(dayStart(d16) + 14 * 3_600_000, dayStart(d16 + 1));
  fill(dayStart(d16 + 1), dayStart(d16 + 1) + 13 * 3_600_000);

  let now = dayStart(d16 + 2) + 2 * 3_600_000;
  const m = new Monitor(store, "v", { now: () => now, fetch: async () => new Response("ok") });
  await m.round(servers); // the first round of the day closes the days before it
  now += 30_000;
  await m.round(servers);

  const days = m.historyStatus("n1", 3).map((d) => [d.up_minutes, d.observed_minutes]);
  expect(days[0]).toEqual([600, 600]);
  expect(days[1]).toEqual([780, 780]);
  expect(store.totals("n1", d16, d16 + 1)).toHaveLength(2);
  expect(store.rolledThrough("n1")).toBe(d16 + 1);
});
