import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "./index";

/**
 * Row-Level Security (RLS) — isolamento multi-tenant no BANCO.
 *
 * As tabelas tenant (com coluna user_id) têm FORCE ROW LEVEL SECURITY + policies
 * `USING (app_row_visible(user_id))` — ver a migration 0008. O predicado passa
 * quando a linha é do usuário do escopo (app.user_id) ou sob bypass de sistema
 * (app.bypass_rls). Fora de um escopo, nenhuma flag está setada → as policies não
 * retornam linha alguma: fail-closed por construção.
 *
 * Padrão de uso: os repositories chamam scopedDb() para obter a conexão corrente
 * (a transação com a flag setada, se dentro de um escopo; senão o db base). Os
 * pontos de entrada abrem o escopo:
 *   - withUserScope(userId, fn)  → leituras/escritas em nome de um usuário (UI/tools);
 *   - withSystemScope(fn)        → webhooks e crons (agem por vários usuários).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Conexão scoped corrente (transação com a flag RLS setada). Propagada pela call
// stack via AsyncLocalStorage — os repos não precisam receber a tx por parâmetro.
const scopeStore = new AsyncLocalStorage<Tx>();

/**
 * Conexão a usar nas queries tenant: a transação scoped corrente, ou o db base
 * (fora de escopo — nesse caso as policies filtram tudo, fail-closed).
 *
 * Tipado como `typeof db`: a transação (Tx) expõe a mesma API de query builder,
 * então o cast preserva a inferência de tipos nos repositories.
 */
export function scopedDb(): typeof db {
  return (scopeStore.getStore() ?? db) as typeof db;
}

/** Abre um escopo de usuário: SET LOCAL app.user_id e roda fn sob ele. */
export async function withUserScope<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!userId) {
    throw new Error("withUserScope: userId is required (RLS fail-closed)");
  }
  return db.transaction(async (tx) => {
    // set_config(_, _, true) = LOCAL (escopo da transação; não vaza no pool).
    // Parametrizado — userId nunca é interpolado na string SQL.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return scopeStore.run(tx, fn);
  });
}

/**
 * Abre um escopo de SISTEMA (bypass do filtro por usuário) — webhooks e crons que
 * agem em nome de vários usuários (settle, reconcile, webhook do Recall). Use só
 * em código server sem input direto do usuário.
 */
export async function withSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return scopeStore.run(tx, fn);
  });
}
