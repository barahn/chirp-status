// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import { rewriteHref, servePage, upstreamPath } from "../src/page";

describe("servePage", () => {
  const page = `<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css?v=1"><script src="/assets/status.js?v=2" defer></script></head>
<body><a class="brand" href="/">Chirp</a><a href="/#download">Download</a><a href="/status/">Network status</a><a href="https://github.com/barahn/chirp">GitHub</a><main data-api="https://status.usechirp.app"></main></body></html>`;
  const site = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push([url, init.method ?? "GET"]);
    if (url === "https://usechirp.app/status/") {
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'",
          "X-GitHub-Request-Id": "x",
        },
      });
    }
    if (url.startsWith("https://usechirp.app/assets/status.js")) {
      return new Response("js", { headers: { "Content-Type": "application/javascript" } });
    }
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  };
  let asked: [string, string][] = [];

  test("the page, with the site's links pointed at the site", async () => {
    asked = [];
    const r = await servePage(new Request("https://status.usechirp.app/"), "https://usechirp.app/", "/status/", site);
    const body = await r.text();
    expect(asked).toEqual([["https://usechirp.app/status/", "GET"]]);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(r.headers.get("X-GitHub-Request-Id")).toBeNull();
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(body).toContain(`<a class="brand" href="https://usechirp.app/">`);
    expect(body).toContain(`href="https://usechirp.app/#download"`);
    expect(body).toContain(`<a href="/">Network status</a>`);
    expect(body).toContain(`href="https://github.com/barahn/chirp"`);
    expect(body).toContain(`href="/assets/site.css?v=1"`);
    expect(body).toContain(`src="/assets/status.js?v=2"`);
  });

  test("security headers the site did not send are filled in, and the site's own kept", async () => {
    const bare = async () => new Response("<p>x</p>", { headers: { "Content-Type": "text/html" } });
    const r = await servePage(new Request("https://status.usechirp.app/"), "https://usechirp.app", "/status/", bare);
    expect(r.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    const own = await servePage(new Request("https://status.usechirp.app/"), "https://usechirp.app/", "/status/", site);
    expect(own.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });

  test("an asset, as it is, with its query", async () => {
    asked = [];
    const r = await servePage(new Request("https://status.usechirp.app/assets/status.js?v=2"), "https://usechirp.app", "/assets/status.js", site);
    expect(asked).toEqual([["https://usechirp.app/assets/status.js?v=2", "GET"]]);
    expect(await r.text()).toBe("js");
  });

  test("the site's errors pass through", async () => {
    const r = await servePage(new Request("https://status.usechirp.app/assets/nope.js"), "https://usechirp.app", "/assets/nope.js", site);
    expect(r.status).toBe(404);
  });
});

const SITE = "https://usechirp.app";

describe("upstreamPath", () => {
  test("the root is the site's status page", () => {
    expect(upstreamPath("/")).toBe("/status/");
    expect(upstreamPath("/index.html")).toBe("/status/");
  });

  test("assets and the icon pass through", () => {
    expect(upstreamPath("/assets/status.js")).toBe("/assets/status.js");
    expect(upstreamPath("/assets/fonts/a.woff2")).toBe("/assets/fonts/a.woff2");
    expect(upstreamPath("/favicon.svg")).toBe("/favicon.svg");
  });

  test("anything else is not the page", () => {
    expect(upstreamPath("/v1/servers")).toBeNull();
    expect(upstreamPath("/healthz")).toBeNull();
    expect(upstreamPath("/l/")).toBeNull();
    expect(upstreamPath("/assets/../l/index.html")).toBeNull();
    expect(upstreamPath("/assets/")).toBeNull();
  });
});

describe("rewriteHref", () => {
  test("the page itself stays here", () => {
    expect(rewriteHref("/status/", SITE)).toBe("/");
    expect(rewriteHref("/status", SITE)).toBe("/");
    expect(rewriteHref("/status/#pve-dc-01", SITE)).toBe("/#pve-dc-01");
    expect(rewriteHref("/status?lang=pt", SITE)).toBe("/?lang=pt");
  });

  test("assets stay here", () => {
    expect(rewriteHref("/assets/site.css?v=1", SITE)).toBe("/assets/site.css?v=1");
    expect(rewriteHref("/favicon.svg?v=1", SITE)).toBe("/favicon.svg?v=1");
  });

  test("the rest of the site goes to the site", () => {
    expect(rewriteHref("/", SITE)).toBe("https://usechirp.app/");
    expect(rewriteHref("/#download", SITE)).toBe("https://usechirp.app/#download");
    expect(rewriteHref("/statusfoo", SITE)).toBe("https://usechirp.app/statusfoo");
    expect(rewriteHref("/l/", SITE + "/")).toBe("https://usechirp.app/l/");
  });

  test("other links are left alone", () => {
    expect(rewriteHref("https://github.com/barahn/chirp", SITE)).toBe("https://github.com/barahn/chirp");
    expect(rewriteHref("#bird-body", SITE)).toBe("#bird-body");
    expect(rewriteHref("//example.com/x", SITE)).toBe("//example.com/x");
  });
});
