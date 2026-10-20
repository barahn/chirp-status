// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// A nickname for every server: a name from Brazilian folklore and a word from
// the trade, so a person can speak of a server without reciting its id —
// "Pisadeira Bitstream" rather than "pve-dc-01".
//
// The nickname is derived, never stored and never authoritative: the id in
// Chirp's network/servers.json is what the API's routes and the Durable
// Object's rows are keyed by, and what the operator chose. Two servers may
// carry the same nickname; only the id is unique.
//
// It is derived from the URL's host, not from an address. A host is what the
// registry records and what a probe asks for; an address is resolved afresh on
// every probe and moves with the hosting or the CDN, so a name made from one
// would not stay put.

/** The folklore half, in the order a hash picks from. */
export const FOLKLORE = [
  "Curupira", "Saci", "Iara", "Boitatá", "Caipora", "Mula-sem-cabeça",
  "Boto", "Cuca", "Mapinguari", "Lobisomem", "Negrinho", "Uirapuru",
  "Anhangá", "Jurupari", "Matinta", "Boiúna", "Pisadeira", "Corpo-seco",
  "Fulozinha", "Papa-figo", "Besta-fera", "Minhocão", "Tutu", "Romãozinho",
  "Capelobo", "Chibamba", "Alamoa", "Guaraciaba", "Jaci", "Caboclo",
  "Zumbi", "Encantado", "Bradador", "Tanga", "Mãe-do-ouro", "Cobra-grande",
  "Labatut", "Acauã", "Tupã", "Ipupiara",
] as const;

/** The second half: the trade's own words. */
export const TECH = [
  "Netrunner", "Daemon", "Quantum", "Cipher", "Kernel", "Nexus",
  "Vector", "Mainframe", "Firewall", "Blackice", "Darknet", "Overclock",
  "Neon", "Chrome", "Synth", "Proxy", "Sentinel", "Bitstream",
  "Zeroday", "Hashgrid", "Lattice", "Deckard", "Wetware", "Uplink",
  "Packet", "Subnet", "Rootkit", "Handshake", "Checksum", "Payload",
  "Terminal", "Spindle",
] as const;

export type Folklore = (typeof FOLKLORE)[number];
export type Tech = (typeof TECH)[number];

/** A nickname: the two halves joined by a space. */
export type Nickname = string;

/** FNV-1a, 32 bits, then an avalanche. Picked because it is a few lines, needs
 * no crypto and has to be stable for good: the nickname a host gets today must
 * be the one it gets in a year, in any runtime.
 *
 * The avalanche is what makes the two halves independent. FNV alone carries
 * its state forward, so hashing the host and then the host with a suffix gives
 * two numbers tied to each other, and hosts that shared one half of the
 * nickname shared the other. Mixing the bits first, and then cutting one
 * number into two indices, leaves the halves free of each other. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // The finalizer from MurmurHash3.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A host as a key: case and a trailing dot ignored, so `Relay.Example.Org.`
 * and `relay.example.org` are one host. */
const key = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");

/** One hash, cut into an index into each list: the low part picks the folklore
 * name, what is left of it picks the word after. 1,280 pairs fit many times
 * over into 32 bits, so neither half crowds the other. */
export function nicknameForHost(host: string): Nickname | undefined {
  const k = key(host);
  if (k === "") return undefined;
  const h = hash(k);
  const a = FOLKLORE[h % FOLKLORE.length]!;
  const b = TECH[Math.floor(h / FOLKLORE.length) % TECH.length]!;
  return `${a} ${b}`;
}

/** The nickname for a server's URL. A URL that will not parse has none, rather
 * than a name made from the broken text: the registry refuses such a URL
 * anyway, and a nickname is not the place to report it. */
export function nicknameForURL(url: string): Nickname | undefined {
  try {
    return nicknameForHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** A nickname as an id the registry would accept: lowercase, accents dropped,
 * anything else a single hyphen. "Mãe-do-ouro Blackice" becomes
 * "mae-do-ouro-blackice". Offered for naming a server, not used for keying
 * anything: an id is the operator's to choose. */
export function slug(nickname: Nickname): string {
  return nickname
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
