// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda
//
// The licence gate. chirp-status ships its own code and nothing else: the
// Worker has no runtime dependency, and every development tool installed must
// carry a permissive licence. Fabrintek owns all of chirp-status and owns none
// of its dependencies, so a copyleft one is refused even though it would be
// licence-compatible (ECOSYSTEM.md). wrangler is run with bunx at a pinned
// version, not installed, for this reason: its tree brings sharp's LGPL
// libvips.
//
// Usage: bun scripts/check-licences.ts   (after bun install)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Zlib", "Unlicense", "BlueOak-1.0.0"]);

/** True when every alternative of an SPDX expression offers a permissive
 * licence: "MIT OR Apache-2.0" passes, "MIT AND GPL-3.0" does not. */
function permissive(expr: string): boolean {
  const e = expr.replace(/[()]/g, " ").trim();
  if (/\bAND\b/.test(e)) return e.split(/\bAND\b/).every((p) => permissive(p));
  return e.split(/\bOR\b/).some((p) => PERMISSIVE.has(p.trim()));
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems: string[] = [];
if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  problems.push(`package.json has runtime dependencies (${Object.keys(pkg.dependencies).join(", ")}): the Worker ships its own code only`);
}

function packages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith(".")) return [];
    if (name.startsWith("@")) return readdirSync(join(dir, name)).map((n) => join(dir, name, n));
    return [join(dir, name)];
  });
}

let checked = 0;
for (const dir of packages("node_modules")) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) continue;
  const p = JSON.parse(readFileSync(file, "utf8"));
  const licence: string = typeof p.license === "string" ? p.license : (p.license?.type ?? "");
  checked++;
  if (!licence) problems.push(`${p.name}@${p.version}: no licence declared`);
  else if (!permissive(licence)) problems.push(`${p.name}@${p.version}: ${licence} is not permissive`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
console.log(`licences: ${checked} packages, all permissive; no runtime dependency`);
