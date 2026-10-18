// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { INTERVAL_MS } from "./uptime";

/** How far past its time a working alarm can be: a round runs late, never
 * this late. */
const OVERDUE_MS = 2 * INTERVAL_MS;

/** Whether the rounds' alarm needs setting: none is set, or the one set is
 * overdue by more than two rounds. An alarm the runtime gave up retrying stays
 * registered for its old time, and taking a set alarm for a running one left
 * the rounds stopped for good. */
export function alarmNeedsSetting(alarm: number | null, now: number): boolean {
  return alarm === null || now - alarm > OVERDUE_MS;
}
