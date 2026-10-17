// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { Database } from "bun:sqlite";
import type { Sql } from "../src/store";

/** The store's SQL over Bun's SQLite, in memory: the same engine and the same
 * SQL a Durable Object's storage runs. */
export function memorySql(): Sql {
  const db = new Database(":memory:", { strict: true });
  return {
    exec: <T,>(query: string, ...bindings: unknown[]) =>
      db.query(query).all(...(bindings as never[])) as T[],
    transaction: (fn) => db.transaction(fn)(),
  };
}

/** memorySql, counting the statements run through it. */
export function countingSql(): { sql: Sql; statements: string[] } {
  const inner = memorySql();
  const statements: string[] = [];
  return {
    statements,
    sql: {
      exec: <T,>(query: string, ...bindings: unknown[]) => {
        statements.push(query.trim().split(/\s+/).slice(0, 3).join(" "));
        return inner.exec<T>(query, ...bindings);
      },
      transaction: (fn) => inner.transaction(fn),
    },
  };
}
