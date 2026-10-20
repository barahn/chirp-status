// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { describe, expect, test } from "bun:test";
import { FOLKLORE, TECH, nicknameForHost, nicknameForURL, slug } from "../src/folklore";

describe("the word lists", () => {
  test("have no repeats", () => {
    expect(new Set(FOLKLORE).size).toBe(FOLKLORE.length);
    expect(new Set(TECH).size).toBe(TECH.length);
  });

  test("are long enough that collisions are rare", () => {
    expect(FOLKLORE.length * TECH.length).toBeGreaterThan(1000);
  });

  test("hold only words a slug can carry", () => {
    for (const w of [...FOLKLORE, ...TECH]) expect(slug(w)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("nicknameForHost", () => {
  test("gives the same host the same name every time", () => {
    const once = nicknameForHost("relay.usechirp.app");
    expect(once).toBeDefined();
    expect(nicknameForHost("relay.usechirp.app")).toBe(once!);
  });

  test("is one word from each list, joined by a space", () => {
    const [a, b, ...rest] = nicknameForHost("relay.example.org")!.split(" ");
    expect(rest).toEqual([]);
    expect(FOLKLORE).toContain(a as never);
    expect(TECH).toContain(b as never);
  });

  test("ignores case and a trailing dot", () => {
    const want = nicknameForHost("relay.example.org");
    expect(nicknameForHost("Relay.Example.ORG")).toBe(want!);
    expect(nicknameForHost("relay.example.org.")).toBe(want!);
    expect(nicknameForHost("  relay.example.org  ")).toBe(want!);
  });

  test("has no name for an empty host", () => {
    expect(nicknameForHost("")).toBeUndefined();
    expect(nicknameForHost("   ")).toBeUndefined();
  });

  test("spreads hosts over many names", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(nicknameForHost(`node-${i}.example.org`)!);
    expect(seen.size).toBeGreaterThan(180);
  });

  test("varies the second half among hosts sharing the first", () => {
    const byFolklore = new Map<string, Set<string>>();
    for (let i = 0; i < 600; i++) {
      const [a, b] = nicknameForHost(`node-${i}.example.org`)!.split(" ");
      (byFolklore.get(a!) ?? byFolklore.set(a!, new Set()).get(a!)!).add(b!);
    }
    const biggest = [...byFolklore.values()].sort((x, y) => y.size - x.size)[0]!;
    expect(biggest.size).toBeGreaterThan(1);
  });

  test("tells sibling hosts apart", () => {
    expect(nicknameForHost("a.example.org")).not.toBe(nicknameForHost("b.example.org"));
  });
});

describe("nicknameForURL", () => {
  test("names the host, not the rest of the URL", () => {
    expect(nicknameForURL("https://relay.example.org")).toBe(nicknameForHost("relay.example.org")!);
    expect(nicknameForURL("https://relay.example.org/")).toBe(nicknameForHost("relay.example.org")!);
  });

  test("has no name for text that is not a URL", () => {
    expect(nicknameForURL("relay.example.org")).toBeUndefined();
    expect(nicknameForURL("")).toBeUndefined();
  });
});

describe("slug", () => {
  test("drops accents and joins with hyphens", () => {
    expect(slug("Mãe-do-ouro Blackice")).toBe("mae-do-ouro-blackice");
    expect(slug("Boitatá Quantum")).toBe("boitata-quantum");
    expect(slug("Mula-sem-cabeça Netrunner")).toBe("mula-sem-cabeca-netrunner");
  });

  test("gives an id the registry's rule accepts", () => {
    for (const f of FOLKLORE) {
      for (const t of TECH) {
        const id = slug(`${f} ${t}`);
        expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(id.length).toBeLessThanOrEqual(40);
      }
    }
  });
});
