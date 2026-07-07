import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "./index";

/**
 * Row-Level Security (RLS) — multi-tenant isolation at the DATABASE level.
 *
 * Tenant tables (with a user_id column) have FORCE ROW LEVEL SECURITY + policies
 * `USING (app_row_visible(user_id))` — see migration 0008. The predicate passes
 * when the row belongs to the scope's user (app.user_id) or under system bypass
 * (app.bypass_rls). Outside a scope, no flag is set → the policies return no
 * rows at all: fail-closed by construction.
 *
 * Usage pattern: repositories call scopedDb() to get the current connection
 * (the transaction with the flag set, if inside a scope; otherwise the base db).
 * The entry points open the scope:
 *   - withUserScope(userId, fn)  → reads/writes on behalf of a user (UI/tools);
 *   - withSystemScope(fn)        → webhooks and crons (act on behalf of multiple users).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Current scoped connection (transaction with the RLS flag set). Propagated
// through the call stack via AsyncLocalStorage — repos don't need to receive
// the tx as a parameter.
const scopeStore = new AsyncLocalStorage<Tx>();

/**
 * Connection to use in tenant queries: the current scoped transaction, or the
 * base db (outside a scope — in that case the policies filter everything, fail-closed).
 *
 * Typed as `typeof db`: the transaction (Tx) exposes the same query builder
 * API, so the cast preserves type inference in the repositories.
 */
export function scopedDb(): typeof db {
  return (scopeStore.getStore() ?? db) as typeof db;
}

/** Opens a user scope: SET LOCAL app.user_id and runs fn under it. */
export async function withUserScope<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!userId) {
    throw new Error("withUserScope: userId is required (RLS fail-closed)");
  }
  return db.transaction(async (tx) => {
    // set_config(_, _, true) = LOCAL (transaction scope; doesn't leak into the pool).
    // Parameterized — userId is never interpolated into the SQL string.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return scopeStore.run(tx, fn);
  });
}

/**
 * Opens a SYSTEM scope (bypasses the per-user filter) — webhooks and crons
 * that act on behalf of multiple users (settle, reconcile, Recall webhook).
 * Use only in server code with no direct user input.
 */
export async function withSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return scopeStore.run(tx, fn);
  });
}
