// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

import { Database } from "bun:sqlite";
import type { Sql } from "../src/store";

/** The store's SQL over Bun's SQLite, in memory, binding numbers as a
 * Durable Object does (realBindingSql): the same engine, the same SQL, and the
 * same types. */
export function memorySql(): Sql {
  return realBindingSql();
}

/** Bun's SQLite as it is, binding a whole number as an INTEGER. */
function plainSql(): Sql {
  const db = new Database(":memory:", { strict: true });
  return {
    exec: <T,>(query: string, ...bindings: unknown[]) =>
      db.query(query).all(...(bindings as never[])) as T[],
    transaction: (fn) => db.transaction(fn)(),
  };
}

/** memorySql, counting the statements run through it. */
export function countingSql(): { sql: Sql; statements: string[] } {
  const inner = realBindingSql();
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

/** memorySql, binding every number as REAL, as a Durable Object's storage
 * does: Bun binds a whole number as an INTEGER, so SQL that only works with
 * integer parameters passes here and fails in production. */
export function realBindingSql(): Sql {
  const inner = plainSql();
  const asReal = (query: string, bindings: unknown[]) => {
    let i = 0;
    return query.replace(/\?/g, () => (typeof bindings[i++] === "number" ? "CAST(? AS REAL)" : "?"));
  };
  return {
    exec: <T,>(query: string, ...bindings: unknown[]) => inner.exec<T>(asReal(query, bindings), ...bindings),
    transaction: (fn) => inner.transaction(fn),
  };
}
