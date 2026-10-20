// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import shipped from "./fixtures/servers.json";
import { NEW_FOR_MS, addedAt, isNew, listing, parseServers, type Server } from "../src/registry";

const node = (): Record<string, unknown> => ({
  id: "node-sp-01", kind: "node", url: "https://relay.example.org",
  operator: "Example", github: "example-ops", behind_cdn: false, added: "2026-10-01",
});

describe("parseServers", () => {
  test("accepts a good entry", () => {
    const [s] = parseServers({ servers: [node()] });
    expect(addedAt(s!)).toBe(Date.UTC(2026, 9, 1));
    expect(listing(s!)).toBe("active");
  });

  test("accepts Chirp's list as it stands", () => {
    expect(parseServers(shipped).length).toBeGreaterThan(0);
  });

  const spoilt: Record<string, (s: Record<string, unknown>) => void> = {
    "id with capitals": (s) => { s.id = "Node"; },
    "id with double hyphen": (s) => { s.id = "a--b"; },
    "unknown kind": (s) => { s.kind = "mirror"; },
    "kind not measured yet": (s) => { s.kind = "nostr"; },
    http: (s) => { s.url = "http://relay.example.org"; },
    "ip address": (s) => { s.url = "https://203.0.113.7"; },
    "ipv6 address": (s) => { s.url = "https://[2001:db8::1]"; },
    path: (s) => { s.url = "https://example.org/relay"; },
    query: (s) => { s.url = "https://example.org/?x=1"; },
    credentials: (s) => { s.url = "https://u:p@example.org"; },
    localhost: (s) => { s.url = "https://localhost"; },
    "no dot": (s) => { s.url = "https://relay"; },
    ".internal": (s) => { s.url = "https://db.corp.internal"; },
    ".local": (s) => { s.url = "https://printer.local"; },
    "numeric last label": (s) => { s.url = "https://127.1"; },
    "no operator": (s) => { s.operator = ""; },
    "no github": (s) => { delete s.github; },
    "bad github": (s) => { s.github = "-ops"; },
    "bad region": (s) => { s.region = "bra"; },
    "bad date": (s) => { s.added = "15/10/2026"; },
    "bad state": (s) => { s.state = "paused"; },
    "misspelt field": (s) => { s.behind_cnd = true; },
  };
  test("refuses a list past the limit", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...node(), id: `n${i}` }));
    expect(() => parseServers({ servers: many })).toThrow();
  });

  for (const [name, spoil] of Object.entries(spoilt)) {
    test(`refuses: ${name}`, () => {
      const s = node();
      spoil(s);
      expect(() => parseServers({ servers: [s] })).toThrow();
    });
  }

  test("refuses a duplicate id, and names it", () => {
    expect(() => parseServers({ servers: [node(), node()] })).toThrow(/twice/);
  });

  test("refuses anything but a list", () => {
    for (const doc of [null, [], {}, { servers: {} }, "x"]) expect(() => parseServers(doc)).toThrow();
  });
});

test("new for NEW_FOR_MS after it was added", () => {
  const s = parseServers({ servers: [node()] })[0] as Server;
  expect(isNew(s, addedAt(s) + NEW_FOR_MS - 1000)).toBe(true);
  expect(isNew(s, addedAt(s) + NEW_FOR_MS)).toBe(false);
});
