// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// When a server last answered is carried in its saved state, which is written
// every round. The last_ok table is the fallback for when that state is gone:
// without it, a monitor that rebuilds from the probes alone reports a server
// that answered last week as never having answered.

import { describe, expect, test } from "bun:test";
import { Monitor } from "../src/monitor";
import { parseServers, type Server } from "../src/registry";
import { Store, dayOf, dayStart } from "../src/store";
import { INTERVAL_MS } from "../src/uptime";
import { countingSql, memorySql } from "./sql";

const d0 = dayOf(Date.UTC(2026, 9, 15));
const t0 = dayStart(d0) + 12 * 3_600_000;
const HOUR = 60 * 60 * 1000;

const servers: Server[] = parseServers({
  servers: [{ id: "n1", kind: "node", url: "https://n1.example.org", operator: "T", github: "t", behind_cdn: false, added: "2026-10-01" }],
});

function fixture(sql = memorySql()) {
  const store = new Store(sql);
  const f = {
    now: t0, healthy: true, sql, store,
    fresh: () => new Monitor(store, "v", { now: () => f.now, fetch: async () => new Response("", { status: f.healthy ? 200 : 503 }) }),
  };
  return f;
}

describe("the last_ok fallback", () => {
  test("is written by a probe that answered", async () => {
    const f = fixture();
    await f.fresh().round(servers);
    expect(f.store.lastOK("n1")).toBe(t0);
  });

  test("is not written by a probe that failed", async () => {
    const f = fixture();
    f.healthy = false;
    await f.fresh().round(servers);
    expect(f.store.lastOK("n1")).toBeUndefined();
  });

  test("restores last_ok when the saved state is gone", async () => {
    const f = fixture();
    const m = f.fresh();
    await m.round(servers);
    const answered = f.now;

    // Ten days off-line, so no probe from when it was up is still inside the
    // window a rebuild reads.
    f.healthy = false;
    for (let d = 1; d <= 10; d++) {
      f.now = dayStart(d0 + d) + 12 * 3_600_000;
      await f.fresh().round(servers);
    }

    // The state is lost, as a dropped or undecodable row would be.
    f.sql.exec("DELETE FROM memory WHERE server_id = ?", "n1");

    expect(f.fresh().status(servers).servers[0]!.last_ok).toBe(new Date(answered).toISOString());
  });

  test("is written at most once an hour", async () => {
    const { sql, statements } = countingSql();
    const f = fixture(sql);
    await f.fresh().round(servers); // writes it the first time
    statements.length = 0;

    // Half an hour of rounds: none of them writes it again.
    for (let i = 0; i < HOUR / 2 / INTERVAL_MS; i++) {
      f.now += INTERVAL_MS;
      await f.fresh().round(servers);
    }
    expect(statements.filter((s) => s.startsWith("INSERT INTO last_ok"))).toEqual([]);

    // Past the hour, the next round writes it once.
    f.now += HOUR;
    statements.length = 0;
    await f.fresh().round(servers);
    expect(statements.filter((s) => s.startsWith("INSERT INTO last_ok"))).toHaveLength(1);
    expect(f.store.lastOK("n1")).toBe(f.now);
  });

  test("costs a round nothing once written, so the write budget is unchanged", async () => {
    const { sql, statements } = countingSql();
    const f = fixture(sql);
    await f.fresh().round(servers);
    f.now += INTERVAL_MS;
    statements.length = 0;
    await f.fresh().round(servers);
    // Only the writes: a monitor fresh for the round also reads its state row,
    // which is what the eviction tests cover.
    expect(statements.filter((s) => s.startsWith("INSERT") || s.startsWith("UPDATE") || s.startsWith("DELETE")))
      .toEqual(["INSERT INTO probes", "INSERT INTO memory"]);
  });

  test("never names a time later than the probes support", async () => {
    const f = fixture();
    const m = f.fresh();
    await m.round(servers);
    const answered = f.now;
    f.healthy = false;
    for (let i = 0; i < 10; i++) {
      f.now += HOUR;
      await m.round(servers);
    }
    // Hours have passed and rounds have run, but none answered.
    expect(f.store.lastOK("n1")).toBe(answered);
  });

  test("survives a state written before it was kept", async () => {
    const f = fixture();
    await f.fresh().round(servers);

    // A state from the old code: the field this relies on is simply absent.
    const old = JSON.parse(f.store.loadState("n1")!);
    delete old.lastOKSaved;
    f.store.saveState("n1", JSON.stringify(old));

    f.now += INTERVAL_MS;
    const m = f.fresh();
    await m.round(servers);
    // It decodes, and treats the fallback as never written, so it writes it.
    expect(f.store.lastOK("n1")).toBe(f.now);
    expect(m.status(servers).servers[0]!.last_ok).toBe(new Date(f.now).toISOString());
  });
});
