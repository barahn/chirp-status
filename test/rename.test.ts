// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// A server renamed in Chirp's registry keeps the record it earned. The record
// is keyed by id in five tables, so what matters is that all five move, that
// they move together, and that two servers are never folded into one.

import { describe, expect, test } from "bun:test";
import { MAX_HISTORY_DAYS, Monitor } from "../src/monitor";
import { parseServers, type Server } from "../src/registry";
import { RENAMES } from "../src/renames";
import { Store, dayOf, dayStart, dayString } from "../src/store";
import { INTERVAL_MS } from "../src/uptime";
import { memorySql } from "./sql";

const d0 = dayOf(Date.UTC(2026, 9, 15));
const t0 = dayStart(d0) + 12 * 3_600_000;

const list = (...ids: string[]): Server[] =>
  parseServers({
    servers: ids.map((id) => ({
      id, kind: "node", url: `https://${id}.example.org`,
      operator: "T", github: "t", behind_cdn: false, added: "2026-10-01",
    })),
  });

function fixture() {
  const store = new Store(memorySql());
  const f = { now: t0, healthy: true, store, monitor: undefined as unknown as Monitor };
  f.monitor = new Monitor(store, "test", {
    now: () => f.now,
    fetch: async () => new Response("", { status: f.healthy ? 200 : 503 }),
  });
  return f;
}

/** Rounds across several days, so there are closed days to move and not just
 * probes from today. */
async function days(f: ReturnType<typeof fixture>, servers: Server[], n: number): Promise<void> {
  for (let d = 0; d < n; d++) {
    for (let i = 0; i < 3; i++) {
      await f.monitor.round(servers);
      f.now += INTERVAL_MS;
    }
    f.now = dayStart(d0 + d + 1) + 12 * 3_600_000;
  }
  await f.monitor.round(servers); // closes the days that ended
}

describe("Store.rename", () => {
  test("moves every table keyed by the id", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 3);
    expect(f.store.has("pve-dc-01")).toBe(true);

    expect(f.store.rename("pve-dc-01", "bradador-vector")).toBe(true);

    expect(f.store.has("pve-dc-01")).toBe(false);
    expect(f.store.has("bradador-vector")).toBe(true);
    expect(f.store.totals("bradador-vector", d0, d0 + 10).length).toBeGreaterThan(0);
    expect(f.store.totals("pve-dc-01", d0, d0 + 10)).toEqual([]);
    expect(f.store.loadState("bradador-vector")).toBeDefined();
    expect(f.store.loadState("pve-dc-01")).toBeUndefined();
    expect(f.store.rolledThrough("bradador-vector")).toBeDefined();
    expect(f.store.rolledThrough("pve-dc-01")).toBeUndefined();
  });

  test("keeps the days exactly as they were", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 4);
    const before = f.store.totals("pve-dc-01", d0, d0 + 10);
    expect(before.length).toBeGreaterThan(1);

    f.store.rename("pve-dc-01", "saci-kernel");

    expect(f.store.totals("saci-kernel", d0, d0 + 10)).toEqual(before);
  });

  test("refuses to fold one server's record into another's", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01", "pve-dc-02"), 2);
    expect(() => f.store.rename("pve-dc-01", "pve-dc-02")).toThrow(/already has a record/);
    // Neither record moved.
    expect(f.store.has("pve-dc-01")).toBe(true);
    expect(f.store.totals("pve-dc-02", d0, d0 + 10).length).toBeGreaterThan(0);
  });

  test("does nothing for an id with no record, and is not an error", () => {
    const f = fixture();
    expect(f.store.rename("never-probed", "iara-cipher")).toBe(false);
    expect(f.store.has("iara-cipher")).toBe(false);
  });

  test("does nothing when the two ids are the same", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 2);
    expect(f.store.rename("pve-dc-01", "pve-dc-01")).toBe(false);
    expect(f.store.has("pve-dc-01")).toBe(true);
  });

  test("applied a second time is a no-op, so a declared rename can stay", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 3);
    const after = (() => {
      f.store.rename("pve-dc-01", "cuca-proxy");
      return f.store.totals("cuca-proxy", d0, d0 + 10);
    })();
    expect(f.store.rename("pve-dc-01", "cuca-proxy")).toBe(false);
    expect(f.store.totals("cuca-proxy", d0, d0 + 10)).toEqual(after);
  });
});

describe("the API after a rename", () => {
  test("the history the page reads follows the server to its new id", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 5);
    const before = f.monitor.historyStatus("pve-dc-01", MAX_HISTORY_DAYS);
    const withData = before.filter((d) => d.observed_minutes > 0);
    expect(withData.length).toBeGreaterThan(1);

    f.monitor.rename("pve-dc-01", "bradador-vector");

    const after = f.monitor.historyStatus("bradador-vector", MAX_HISTORY_DAYS);
    expect(after.filter((d) => d.observed_minutes > 0)).toEqual(withData);
    // And the day strings still name the days that were measured.
    expect(withData.map((d) => d.day)).toContain(dayString(d0));
  });

  test("the snapshot carries the uptime over to the new id", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 5);
    const before = f.monitor.status(list("pve-dc-01")).servers[0]!;
    expect(before.uptime["90d"].observed_minutes).toBeGreaterThan(0);

    f.monitor.rename("pve-dc-01", "bradador-vector");

    const after = f.monitor.status(list("bradador-vector")).servers[0]!;
    expect(after.id).toBe("bradador-vector");
    expect(after.uptime["90d"]).toEqual(before.uptime["90d"]);
    expect(after.last_ok).toBe(before.last_ok);
  });

  test("the old id has nothing left to report", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 3);
    f.monitor.rename("pve-dc-01", "bradador-vector");
    const old = f.monitor.historyStatus("pve-dc-01", MAX_HISTORY_DAYS);
    expect(old.every((d) => d.observed_minutes === 0)).toBe(true);
  });

  test("rounds carry on under the new id after the rename", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 3);
    f.monitor.rename("pve-dc-01", "bradador-vector");
    const observedBefore = f.monitor.status(list("bradador-vector")).servers[0]!.uptime["90d"].observed_minutes;

    for (let i = 0; i < 4; i++) {
      await f.monitor.round(list("bradador-vector"));
      f.now += INTERVAL_MS;
    }

    const s = f.monitor.status(list("bradador-vector")).servers[0]!;
    expect(s.state).toBe("up");
    expect(s.uptime["90d"].observed_minutes).toBeGreaterThanOrEqual(observedBefore);
  });
});

describe("the declared renames", () => {
  test("name ids the registry's rule accepts", () => {
    for (const r of RENAMES) {
      expect(r.from).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(r.to).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(r.to.length).toBeLessThanOrEqual(40);
      expect(r.from).not.toBe(r.to);
    }
  });

  test("move each record once: no id is renamed twice", () => {
    const froms = RENAMES.map((r) => r.from);
    expect(new Set(froms).size).toBe(froms.length);
    const tos = RENAMES.map((r) => r.to);
    expect(new Set(tos).size).toBe(tos.length);
  });

  test("a rename is applied on the first round and not on the next", async () => {
    const f = fixture();
    await days(f, list("pve-dc-01"), 3);
    const before = f.store.totals("pve-dc-01", d0, d0 + 10);
    expect(before.length).toBeGreaterThan(0);

    // A fresh monitor over the same storage: what an object Cloudflare brings
    // back does on its first round.
    const fresh = new Monitor(f.store, "test", { now: () => f.now, fetch: async () => new Response("ok") });
    await fresh.round(list("bradador-vector"));

    expect(f.store.has("pve-dc-01")).toBe(false);
    expect(f.store.totals("bradador-vector", d0, d0 + 10)).toEqual(before);
  });
});
