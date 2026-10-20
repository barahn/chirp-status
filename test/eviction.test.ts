// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// Cloudflare may take a Durable Object out of memory at any time, and in
// production it did, all but between every request: 16 million rows read for
// 6,500 requests. Whatever the monitor keeps in memory has to be had back for
// a few rows, never by working the figures out again from storage.

import { expect, test } from "bun:test";
import { Monitor } from "../src/monitor";
import { parseServers } from "../src/registry";
import { Store, dayOf, dayStart } from "../src/store";
import { INTERVAL_MS } from "../src/uptime";
import { countingSql } from "./sql";

const servers = parseServers({
  servers: [{ id: "n1", kind: "node", url: "https://n1.example.org", operator: "T", github: "t", behind_cdn: false, added: "2026-10-15" }],
});
const d0 = dayOf(Date.UTC(2026, 9, 18));

test("an object recreated before every round and every answer reads a handful of rows", async () => {
  const { sql, rows } = countingSql();
  const store = new Store(sql);
  let now = dayStart(d0) + 20 * 3_600_000;
  const fresh = () => new Monitor(store, "v", { now: () => now, fetch: async () => new Response("ok") });

  // A day and a half of rounds, the object recreated each time.
  const perRound: number[] = [];
  const perAnswer: number[] = [];
  for (let i = 0; i < 2 * 60 * 30; i++) {
    let before = rows.n;
    await fresh().round(servers);
    perRound.push(rows.n - before);
    before = rows.n;
    fresh().status(servers);
    fresh().historyStatus("n1", 90);
    perAnswer.push(rows.n - before);
    now += INTERVAL_MS;
  }
  // No round reads more than a few rows, closing a day included: the day is
  // totalled from the state row the object just read, not from its probes.
  expect(Math.max(...perRound)).toBeLessThanOrEqual(10);
  expect(Math.max(...perAnswer)).toBeLessThanOrEqual(10);
  // And what it says is what an object that never left memory would say.
  const kept = new Monitor(store, "v", { now: () => now, fetch: async () => new Response("ok") });
  expect(fresh().status(servers)).toEqual(kept.status(servers));
  expect(fresh().historyStatus("n1", 3)).toEqual(kept.historyStatus("n1", 3));
}, 60_000); // 3,600 rounds, each by an object made anew

test("a state row that will not decode starts the server afresh instead of stopping the rounds", async () => {
  const { sql } = countingSql();
  const store = new Store(sql);
  let now = dayStart(d0) + 12 * 3_600_000;
  const monitor = () => new Monitor(store, "v", { now: () => now, fetch: async () => new Response("ok") });

  // A day closed, so there is a record in storage besides the state row.
  await monitor().round(servers);
  now = dayStart(d0 + 1) + 60_000;
  await monitor().round(servers);
  const closed = monitor().historyStatus("n1", 2)[0]!;
  expect(closed.observed_minutes).toBeGreaterThan(0);

  // The row is now written by a version this one cannot read.
  store.saveState("n1", `{"minutes":[[`);
  now += INTERVAL_MS;
  const fresh = monitor();
  expect(() => fresh.status(servers)).not.toThrow();
  await fresh.round(servers); // the round goes on rather than throwing out of the alarm

  const s = fresh.status(servers).servers[0]!;
  expect(s.state).toBe("up");
  expect(s.last_checked).toBe(new Date(now).toISOString());
  // The day in course is gone, as it only ever lived in that row; the day
  // already closed is not, since its total is its own row.
  expect(fresh.historyStatus("n1", 2)[0]).toEqual(closed);
  // And the row left behind is one this version can read.
  expect(() => new Monitor(store, "v", { now: () => now, fetch: async () => new Response("ok") }).status(servers)).not.toThrow();
});
