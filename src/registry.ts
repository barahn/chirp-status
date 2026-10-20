// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// The network's members, as Chirp's network/servers.json lists them. The list
// is Chirp's; this checks it the way Chirp's own tests do, and refuses all of
// it if any entry is wrong, so a bad edit never half-applies.

export type Kind = "node" | "nostr" | "turn";
export type Listing = "active" | "suspended";

/** How long a member counts as new after it was added. */
export const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export interface Server {
  id: string;
  kind: Kind;
  url: string;
  operator: string;
  github: string;
  contact?: string;
  region?: string;
  behind_cdn: boolean;
  added: string;
  state?: Listing;
}

/** The most servers a registry may list. A list far beyond what the network
 * has is an error, or an attempt to make the monitor probe without end. */
export const MAX_SERVERS = 500;

/** Names that never belong to a public server: probing one would reach
 * something inside the network the Worker runs in, or nothing at all. */
const RESERVED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".corp", ".intranet", ".invalid", ".test"];

const FIELDS = new Set(["id", "kind", "url", "operator", "github", "contact", "region", "behind_cdn", "added", "state"]);
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GITHUB = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REGION = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day a member was added, at 00:00 UTC. */
export const addedAt = (s: Server): number => Date.parse(`${s.added}T00:00:00Z`);

export const isNew = (s: Server, now: number): boolean => now - addedAt(s) < NEW_FOR_MS;

export const listing = (s: Server): Listing => s.state ?? "active";

/** Parses and checks a registry document. It throws with every problem it
 * finds, not just the first. */
export function parseServers(doc: unknown): Server[] {
  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { servers?: unknown }).servers)) {
    throw new Error('the registry must be {"servers": [...]}');
  }
  if ((doc as { servers: unknown[] }).servers.length > MAX_SERVERS) {
    throw new Error(`the registry lists more than ${MAX_SERVERS} servers`);
  }
  const extra = Object.keys(doc).filter((k) => k !== "servers");
  const errs: string[] = extra.map((k) => `unknown field ${JSON.stringify(k)}`);
  const seen = new Set<string>();
  const servers = (doc as { servers: unknown[] }).servers;
  servers.forEach((raw, i) => {
    const s = raw as Record<string, unknown>;
    const id = typeof s?.id === "string" ? s.id : "";
    for (const e of check(s)) errs.push(`server ${i} (${JSON.stringify(id)}): ${e}`);
    if (seen.has(id)) errs.push(`server ${i}: id ${JSON.stringify(id)} is listed twice`);
    seen.add(id);
  });
  if (errs.length > 0) throw new Error(errs.join("; "));
  return servers as Server[];
}

function check(s: Record<string, unknown>): string[] {
  if (typeof s !== "object" || s === null) return ["not an object"];
  const errs: string[] = [];
  for (const k of Object.keys(s)) if (!FIELDS.has(k)) errs.push(`unknown field ${JSON.stringify(k)}`);
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : undefined);
  const id = str("id") ?? "";
  if (id.length > 40 || !ID.test(id)) errs.push("id must be lowercase letters and digits joined by single hyphens, at most 40");
  const kind = str("kind");
  if (kind === "nostr" || kind === "turn") errs.push(`kind "${kind}" is not measured yet: only "node" is`);
  else if (kind !== "node") errs.push(`kind ${JSON.stringify(s.kind)} is not one of node, nostr, turn`);
  const urlErr = checkURL(str("url"));
  if (urlErr) errs.push(urlErr);
  if (!str("operator")) errs.push("operator is required");
  if (!GITHUB.test(str("github") ?? "")) errs.push("github must be the operator's GitHub handle: alerts reach them through it");
  if (s.contact !== undefined && typeof s.contact !== "string") errs.push("contact must be a string");
  if (s.region !== undefined && !REGION.test(str("region") ?? "")) errs.push("region must be an ISO 3166 two-letter code in capitals");
  if (typeof s.behind_cdn !== "boolean" && s.behind_cdn !== undefined) errs.push("behind_cdn must be true or false");
  const added = str("added") ?? "";
  if (!DATE.test(added) || Number.isNaN(Date.parse(`${added}T00:00:00Z`))) errs.push("added must be a date, YYYY-MM-DD");
  if (s.state !== undefined && s.state !== "active" && s.state !== "suspended") errs.push(`state ${JSON.stringify(s.state)} is not active or suspended`);
  return errs;
}

/** Only what the conformance rules allow a node to be reached at: HTTPS, by a
 * domain name, at its root. */
function checkURL(raw: string | undefined): string | undefined {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    return "url is not a URL";
  }
  if (u.protocol !== "https:") return "url must be https";
  const host = u.hostname;
  if (host === "") return "url has no host";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return "url must name a domain, not an IP address";
  const labels = host.split(".");
  const last = labels[labels.length - 1]!;
  if (labels.length < 2 || last === "") return "url must name a public domain, with at least two labels";
  if (host === "localhost" || RESERVED_SUFFIXES.some((x) => host.endsWith(x))) return "url must not name a local or reserved domain";
  if (/^(\d+|0x[0-9a-f]*)$/i.test(last)) return "url must name a domain, not an IP address";
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "" && u.pathname !== "/") || raw!.includes("?") || raw!.includes("#")) {
    return "url must be the server's root, with nothing after the host";
  }
  return undefined;
}
