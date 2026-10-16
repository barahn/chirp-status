// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { expect, test } from "bun:test";
import { probe, type ProbeDeps } from "../src/probe";

/** A fetch that answers with status, or throws error, and records what it was
 * asked. */
function fake(answer: number | Error, asked: { url?: string; init?: RequestInit } = {}): ProbeDeps {
  let clock = 1_000;
  return {
    now: () => (clock += 40),
    fetch: async (url, init) => {
      asked.url = url;
      asked.init = init;
      if (answer instanceof Error) throw answer;
      return new Response("ok\n", { status: answer });
    },
  };
}

test("a 200 is up, and its latency is measured", async () => {
  const asked: { url?: string; init?: RequestInit } = {};
  expect(await probe("https://relay.example.org", fake(200, asked))).toEqual({ ok: true, latencyMs: 40, err: "" });
  expect(asked.url).toBe("https://relay.example.org/healthz");
  expect(asked.init?.redirect).toBe("manual");
  expect(asked.init?.signal).toBeDefined();
});

test("any other status is down", async () => {
  for (const status of [500, 404, 302, 204]) {
    expect(await probe("https://relay.example.org/", fake(status))).toMatchObject({ ok: false, err: "status" });
  }
});

test("a timeout is told apart from other failures", async () => {
  const timeout = new DOMException("timed out", "TimeoutError");
  expect(await probe("https://relay.example.org", fake(timeout))).toMatchObject({ ok: false, err: "timeout" });
  expect(await probe("https://relay.example.org", fake(new TypeError("fetch failed")))).toMatchObject({ ok: false, err: "other" });
});
