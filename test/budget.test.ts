// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// A Durable Object on Cloudflare's free plan may read five million rows a day
// and write a hundred thousand. Working out the figures from storage on every
// request spent the reads in a day. These hold the monitor to what it may
// spend: storage is read to start and once a day, never to answer.

import { expect, test } from "bun:test";
import { Monitor } from "../src/monitor";
import { parseServers } from "../src/registry";
import { Store } from "../src/store";
import { INTERVAL_MS } from "../src/uptime";
import { countingSql } from "./sql";

const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const servers = parseServers({
  servers: ["a", "b", "c"].map((id) => ({
    id, kind: "node", url: `https://${id}.example.org`, operator: "Test", github: "test", behind_cdn: false, added: "2026-10-01",
  })),
});

function fixture() {
  const { sql, statements } = countingSql();
  const store = new Store(sql);
  const f = { now: t0, healthy: true, statements, store, monitor: undefined as unknown as Monitor };
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

test("a round writes each server's probe and its state, and reads nothing", async () => {
  const f = fixture();
  await f.monitor.round(servers); // the first round of the day also closes days
  f.now += INTERVAL_MS;
  f.statements.length = 0;
  await f.monitor.round(servers);
  expect(f.statements).toEqual(Array(servers.length).fill(["INSERT INTO probes", "INSERT INTO memory"]).flat());
});

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
