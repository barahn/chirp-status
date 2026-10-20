// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import { FOLKLORE, TECH } from "../src/folklore";
import { MAX_HISTORY_DAYS, Monitor } from "../src/monitor";
import { parseServers } from "../src/registry";
import { Store, dayOf, dayStart, dayString } from "../src/store";
import { INTERVAL_MS, STALE_AFTER_MS } from "../src/uptime";
import { memorySql } from "./sql";

const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const servers = parseServers({
  servers: [{ id: "n1", kind: "node", url: "https://n1.example.org", operator: "Test", github: "test", behind_cdn: false, added: "2026-10-01" }],
});

/** A monitor watching one node whose health the test switches, on a clock
 * the test moves. */
function fixture(start = t0) {
  const f = {
    now: start,
    healthy: true,
    store: new Store(memorySql()),
    monitor: undefined as unknown as Monitor,
    /** One round, then the clock moves on by an interval. */
    async round() {
      await f.monitor.round(servers);
      const s = f.monitor.status(servers).servers[0]!;
      f.now += INTERVAL_MS;
      return s;
    },
  };
  f.monitor = new Monitor(f.store, "test", {
    now: () => f.now,
    fetch: async () => new Response("", { status: f.healthy ? 200 : 503 }),
  });
  return f;
}

/** Probes every interval from from up to to, as up or down. Single probes are
 * not kept, so a past day is made the way it is really made: by rounds. */
async function fill(f: ReturnType<typeof fixture>, from: number, to: number, ok: boolean) {
  f.now = from;
  f.healthy = ok;
  while (f.now < to) {
    await f.monitor.round(servers);
    f.now += INTERVAL_MS;
  }
}

test("off-line after three failed rounds, and since when", async () => {
  const f = fixture();
  const first = await f.round();
  expect(first.state).toBe("up");
  expect(first.latency_ms).not.toBeNull();
  const lastOK = new Date(t0).toISOString();

  f.healthy = false;
  for (const want of ["failing", "failing", "offline", "offline"]) {
    const s = await f.round();
    expect(s.state).toBe(want as typeof s.state);
    expect(s.last_ok).toBe(lastOK);
    expect(s.last_error).toBe("status");
    expect(s.latency_ms).toBeNull();
  }
  f.healthy = true;
  expect((await f.round()).state).toBe("up");

  // The monitor itself stops probing: after three missed rounds it no
  // longer claims to know.
  f.now += STALE_AFTER_MS;
  expect(f.monitor.status(servers).servers[0]!.state).toBe("unknown");
});

test("days are totalled, gaps stay gaps, and only the total is kept", async () => {
  const today = dayOf(t0);
  const f = fixture(dayStart(today - 3));
  await fill(f, dayStart(today - 3), dayStart(today - 2), true); // a full day up
  // today-2: the monitor was down all day. No probes, no data.
  const half = dayStart(today - 1) + 12 * HOUR;
  await fill(f, dayStart(today - 1), half, true); // up for twelve hours
  await fill(f, half, dayStart(today), false); // then down for twelve
  await fill(f, dayStart(today), t0, true); // up since midnight

  f.now = t0;
  f.healthy = true;
  const s = await f.round();
  f.now -= INTERVAL_MS;

  const days = f.monitor.historyStatus("n1", 4);
  expect(days.map((d) => [d.day, d.up_minutes, d.observed_minutes, d.percent])).toEqual([
    [dayString(today - 3), 1440, 1440, 100],
    [dayString(today - 2), 0, 0, null],
    [dayString(today - 1), 720, 1440, 50],
    [dayString(today), 720, 720, 100], // the round probes at 12:00, a minute not over yet
  ]);
  expect(days.map((d) => d.p50_ms === null)).toEqual([false, true, false, false]);

  // The 30-day figure is the sum of the days the history shows.
  expect(s.uptime["30d"]).toMatchObject({ up_minutes: 1440 + 720 + 720, observed_minutes: 1440 + 1440 + 720 });
  // The last 24 hours: 12 h down, then 12 h up.
  expect(s.uptime["24h"]).toMatchObject({ up_minutes: 720, observed_minutes: 1440 });
  expect(s.uptime["90d"].observed_minutes).toBe(s.uptime["30d"].observed_minutes);

  // A day that ended is in storage as its total, and that is all of it.
  const totals = f.store.totals("n1", today - 3, today - 1);
  expect(totals.map((t) => [t.day, t.uptime.up, t.uptime.observed])).toEqual([
    [today - 3, 1440, 1440],
    [today - 1, 720, 1440],
  ]);
  // What it says is what an object that never left memory would say.
  const restarted = new Monitor(f.store, "test", { now: () => f.now, fetch: async () => new Response("") });
  expect(restarted.historyStatus("n1", 4)).toEqual(days);
}, 60_000); // four days of rounds

describe("history", () => {
  test("holds its own bound on the days it allocates for", () => {
    const f = fixture();
    for (const n of [0, -1, MAX_HISTORY_DAYS + 1, 2 ** 40, 1.5, Number.NaN]) {
      expect(() => f.monitor.history("n1", dayOf(t0), n, t0)).toThrow(RangeError);
    }
    expect(f.monitor.history("n1", dayOf(t0), MAX_HISTORY_DAYS, t0)).toHaveLength(MAX_HISTORY_DAYS);
  });
});

test("the snapshot has every field the status page reads", async () => {
  const f = fixture();
  await f.round();
  const snap = f.monitor.status(servers);
  expect(snap).toMatchObject({ vantage: "test", interval_seconds: 30 });
  expect(Date.parse(snap.generated_at)).toBe(f.now);
  const s = snap.servers[0]!;
  expect(Object.keys(s).sort()).toEqual([
    "added", "behind_cdn", "id", "kind", "last_checked", "last_ok", "latency_ms",
    "listing", "new", "nickname", "operator", "state", "uptime", "url",
  ]);
  expect(s).toMatchObject({ id: "n1", new: true, listing: "active" });
  const [folk, tech] = s.nickname!.split(" ");
  expect(FOLKLORE).toContain(folk as never);
  expect(TECH).toContain(tech as never);
  expect(Object.keys(s.uptime).sort()).toEqual(["24h", "30d", "90d"]);
});
