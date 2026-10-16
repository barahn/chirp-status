// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// Where the monitor runs: one Durable Object, which probes on an alarm every
// 30 s and keeps its record in its own SQLite storage, and the Worker in front
// of it, which serves the API. There is one monitor, so one object: it is the
// single place the figures are made, and it stays where it was created, which
// keeps its vantage point the same from one round to the next.

import { DurableObject } from "cloudflare:workers";
import { MAX_HISTORY_DAYS, Monitor, type DayStatus, type Snapshot } from "./monitor";
import { servePage, upstreamPath } from "./page";
import { parseServers, type Server } from "./registry";
import { Store, type Sql } from "./store";
import { INTERVAL_MS } from "./uptime";

export interface Env {
  STATUS: DurableObjectNamespace<StatusMonitor>;
  /** Chirp's network/servers.json, on Chirp's main. */
  REGISTRY_URL: string;
  /** Where the probes come from, as the page shows it. */
  VANTAGE: string;
  /** The one origin whose pages may read the API. */
  ALLOW_ORIGIN: string;
  /** The site the status page is published on, served from here at /. */
  SITE_ORIGIN: string;
}

/** How long a fetched registry is used before it is fetched again. */
const REGISTRY_FOR_MS = 5 * 60 * 1000;

interface CachedRegistry {
  fetchedAt: number;
  servers: Server[];
}

export class StatusMonitor extends DurableObject<Env> {
  private readonly monitor: Monitor;
  private registry: CachedRegistry | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: Sql = {
      exec: <T,>(query: string, ...bindings: unknown[]) => ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    this.monitor = new Monitor(new Store(sql), env.VANTAGE || "Cloudflare", { fetch: (url, init) => fetch(url, init), now: Date.now });
  }

  /** Starts the rounds if they are not running. Called on every request and
   * by the cron, so an alarm that was ever lost is set again. */
  async ensureRunning(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    // The next round is set first: a round that throws still has a successor.
    await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
    await this.monitor.round(await this.servers());
  }

  async snapshot(): Promise<Snapshot> {
    return this.monitor.status(await this.servers());
  }

  /** One server's history, or null for a server the list does not have. */
  async history(id: string, days: number): Promise<DayStatus[] | null> {
    if (!(await this.servers()).some((s) => s.id === id)) return null;
    return this.monitor.historyStatus(id, days);
  }

  /** The network's servers: Chirp's list, fetched at most every
   * REGISTRY_FOR_MS. A list that does not load or does not check keeps the
   * last one that did, which is also kept in storage across restarts. */
  private async servers(): Promise<Server[]> {
    const now = Date.now();
    this.registry ??= await this.ctx.storage.get<CachedRegistry>("registry");
    if (this.registry && now - this.registry.fetchedAt < REGISTRY_FOR_MS) return this.registry.servers;
    try {
      const resp = await fetch(this.env.REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`${this.env.REGISTRY_URL}: ${resp.status}`);
      const servers = parseServers(await resp.json());
      this.registry = { fetchedAt: now, servers };
      await this.ctx.storage.put("registry", this.registry);
    } catch (e) {
      console.error(`chirp-status: keeping the last list: ${(e as Error).message}`);
      if (this.registry) this.registry = { ...this.registry, fetchedAt: now };
    }
    return this.registry?.servers ?? [];
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers({
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      // The page reads the monitor's clock from Date, so the ages it shows
      // do not depend on the visitor's clock being right.
      Date: new Date().toUTCString(),
    });
    if (env.ALLOW_ORIGIN) {
      headers.set("Access-Control-Allow-Origin", env.ALLOW_ORIGIN);
      headers.set("Access-Control-Expose-Headers", "Date");
      headers.set("Vary", "Origin");
    }
    const json = (body: unknown, status = 200) => {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(body), { status, headers });
    };
    const text = (body: string, status: number) => {
      headers.set("Content-Type", "text/plain; charset=utf-8");
      return new Response(body + "\n", { status, headers });
    };

    if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed", 405);
    if (url.pathname === "/healthz") return text("ok", 200);

    // The page used to be at usechirp.app/status/; here it is at /.
    if (url.pathname === "/status" || url.pathname === "/status/") {
      return Response.redirect(new URL("/" + url.search, url).toString(), 301);
    }
    const page = upstreamPath(url.pathname);
    if (page !== null) {
      try {
        return await servePage(request, env.SITE_ORIGIN || "https://usechirp.app", page, (u, i) => fetch(u, i));
      } catch (e) {
        console.error(`chirp-status: page: ${(e as Error).message}`);
        return text("the status page could not be loaded; the figures are at /v1/servers", 502);
      }
    }

    const stub = env.STATUS.getByName("monitor");
    ctx.waitUntil(stub.ensureRunning());

    if (url.pathname === "/v1/servers") return json(await stub.snapshot());

    const m = /^\/v1\/servers\/([a-z0-9-]{1,40})\/history$/.exec(url.pathname);
    if (m) {
      const raw = url.searchParams.get("days");
      const days = raw === null ? MAX_HISTORY_DAYS : Number(raw);
      if (!/^\d+$/.test(raw ?? "90") || days < 1 || days > MAX_HISTORY_DAYS) {
        return text(`days must be 1 to ${MAX_HISTORY_DAYS}`, 400);
      }
      const history = await stub.history(m[1]!, days);
      if (history === null) return text("no such server", 404);
      return json({ id: m[1], days: history });
    }
    return text("not found", 404);
  },

  // A watchdog: the rounds run on the object's own alarm, and this only sets
  // it again if it was ever lost.
  async scheduled(_controller, env): Promise<void> {
    await env.STATUS.getByName("monitor").ensureRunning();
  },
} satisfies ExportedHandler<Env>;
