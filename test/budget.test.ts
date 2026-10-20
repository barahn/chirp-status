// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// A Durable Object on Cloudflare's free plan may read five million rows a day
// and write a hundred thousand. Working out the figures from storage on every
// request spent the reads in a day, and a row per probe spent the writes.
// These hold the monitor to what it may spend: storage is read to start and
// once a day, never to answer, and a round writes one row per server.

import { expect, test } from "bun:test";
import { Monitor } from "../src/monitor";
import { parseServers } from "../src/registry";
import { Store, dayOf, dayStart } from "../src/store";
import { INTERVAL_MS } from "../src/uptime";
import { countingSql } from "./sql";

const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);
/** What the free plan allows one Durable Object to write in a day. */
const FREE_WRITES_A_DAY = 100_000;
const ROUNDS_A_DAY = (24 * 60 * 60 * 1000) / INTERVAL_MS;
const servers = parseServers({
  servers: ["a", "b", "c"].map((id) => ({
    id, kind: "node", url: `https://${id}.example.org`, operator: "Test", github: "test", behind_cdn: false, added: "2026-10-01",
  })),
});

function fixture(start = t0) {
  const { sql, statements } = countingSql();
  const store = new Store(sql);
  const f = { now: start, healthy: true, statements, store, monitor: undefined as unknown as Monitor };
  f.monitor = new Monitor(store, "test", {
    now: () => f.now,
    fetch: async () => new Response("", { status: f.healthy ? 200 : 503 }),
  });
  return f;
}

test("answering the API reads nothing from storage", async () => {
  const f = fixture();
  await f.monitor.round(servers);
  f.now += INTERVAL_MS;
  f.statements.length = 0;
  for (let i = 0; i < 100; i++) {
    f.monitor.status(servers);
    f.monitor.historyStatus("a", 90);
  }
  expect(f.statements).toEqual([]);
});

test("a round writes one row per server and reads nothing", async () => {
  const f = fixture();
  await f.monitor.round(servers); // the first round of the day also closes days
  f.now += INTERVAL_MS;
  f.statements.length = 0;
  await f.monitor.round(servers);
  expect(f.statements).toEqual(Array(servers.length).fill("INSERT INTO memory"));
});

test("a day of rounds stays inside the free plan's writes, with servers to spare", async () => {
  const f = fixture(dayStart(dayOf(t0)));
  // A whole day of rounds, from midnight to midnight, closing the day before
  // on the first round and the day itself on the last.
  const end = f.now + 24 * 60 * 60 * 1000;
  f.statements.length = 0;
  while (f.now < end) {
    await f.monitor.round(servers);
    f.now += INTERVAL_MS;
  }
  await f.monitor.round(servers);

  // Storage is read three times per server, all of it on the very first
  // round: its state row, how far it is closed, and the days already closed.
  const reads = f.statements.filter((q) => q.startsWith("SELECT"));
  expect(reads).toHaveLength(3 * servers.length);
  // Every other statement writes exactly one row: the state row a round
  // upserts, a day's total, or how far the server is closed.
  const writes = f.statements.filter((q) => q.startsWith("INSERT"));
  expect(writes).toHaveLength(f.statements.length - reads.length);
  // One write a round, and a handful besides: the state row each server
  // starts with, and the two days closed, each a total and a mark of how far
  // the server is closed.
  const perServer = writes.length / servers.length;
  expect(perServer).toBeLessThanOrEqual(ROUNDS_A_DAY + 8);
  // What the free plan affords, at this cost: enough servers to grow into.
  expect(Math.floor(FREE_WRITES_A_DAY / perServer)).toBeGreaterThanOrEqual(30);
  // And the figures are still right after a day of it.
  expect(f.monitor.status(servers).servers[0]!.uptime["24h"].percent).toBe(100);
}, 120_000); // a day of rounds for every server

test("when a server last answered survives a restart", async () => {
  const f = fixture();
  await f.monitor.round(servers);
  f.now += INTERVAL_MS;
  const lastOK = f.now;
  await f.monitor.round(servers);
  f.now += INTERVAL_MS;
  f.healthy = false;
  await f.monitor.round(servers);

  // A new monitor over the same storage, as after the object restarts.
  f.now += INTERVAL_MS;
  const before = f.monitor.status(servers);
  const restarted = new Monitor(f.store, "test", { now: () => f.now, fetch: async () => new Response("") });
  const after = restarted.status(servers);
  expect(after).toEqual(before);
  expect(after.servers[0]!.last_ok).toBe(new Date(lastOK).toISOString());
});
