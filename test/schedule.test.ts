// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { expect, test } from "bun:test";
import { alarmNeedsSetting } from "../src/schedule";
import { INTERVAL_MS } from "../src/uptime";

const now = Date.UTC(2026, 9, 18, 0, 30, 0);

test("no alarm at all is set", () => {
  expect(alarmNeedsSetting(null, now)).toBe(true);
});

test("an alarm still to come, or just due, is left alone", () => {
  expect(alarmNeedsSetting(now + INTERVAL_MS, now)).toBe(false);
  expect(alarmNeedsSetting(now - 5_000, now)).toBe(false);
  expect(alarmNeedsSetting(now - 2 * INTERVAL_MS, now)).toBe(false);
});

// After the free plan's limit blocked storage for a day, the alarm stayed
// registered for a time long past, the runtime having given up retrying it,
// and the rounds never came back: a set alarm was taken to be a running one.
test("an alarm overdue by more than two rounds is set again", () => {
  expect(alarmNeedsSetting(now - 2 * INTERVAL_MS - 1, now)).toBe(true);
  expect(alarmNeedsSetting(now - 11 * 60 * 60 * 1000, now)).toBe(true);
});
