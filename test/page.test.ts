// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import { rewriteHref, upstreamPath } from "../src/page";

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
