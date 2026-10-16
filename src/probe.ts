// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import type { Sample } from "./uptime";

/** How long a server has to answer a probe. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Why a probe failed: which layer gave out, nothing more. A Worker's fetch
 * does not say whether a failure was the name, the connection or TLS, so all
 * of those are "other". */
export type ProbeError = "" | "timeout" | "status" | "other";

/** A clock and a fetch, so tests can run probes without the network. */
export interface ProbeDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}

/** Asks the node at base for /healthz. It is up if it answers 200 within
 * PROBE_TIMEOUT_MS. A redirect is not followed, and counts as down: a node
 * answers at its own address. The sample's vantage and time are the caller's
 * to set. */
export async function probe(base: string, deps: ProbeDeps): Promise<Pick<Sample, "ok" | "latencyMs" | "err">> {
  const start = deps.now();
  try {
    const resp = await deps.fetch(new URL("/healthz", base).toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "chirp-status (+https://usechirp.app/status/)" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // The body is not read beyond what closing it needs.
    await resp.body?.cancel();
    const latencyMs = Math.max(0, deps.now() - start);
    if (resp.status !== 200) return { ok: false, latencyMs, err: "status" };
    return { ok: true, latencyMs, err: "" };
  } catch (e) {
    const latencyMs = Math.max(0, deps.now() - start);
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, latencyMs, err: "timeout" };
    return { ok: false, latencyMs, err: "other" };
  }
}
