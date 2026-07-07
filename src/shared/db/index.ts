import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "@/mastra/env";
import * as schema from "./schema";

/**
 * Cliente Drizzle (node-postgres) compartilhado.
 *
 * Pool único reutilizado entre invocações (evita esgotar conexões em serverless
 * e em hot-reload do dev). Conexão via DATABASE_URL.
 */

declare global {
  var __recallPgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__recallPgPool) {
    globalThis.__recallPgPool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
    });
  }
  return globalThis.__recallPgPool;
}

// Instância drizzle criada só no primeiro uso. Se `db` fosse inicializado no
// top-level (`drizzle(getPool())`), `requireEnv("DATABASE_URL")` rodaria já no
// import — e o `next build` coleta page data importando as rotas, quebrando o
// build sem DATABASE_URL. O Proxy adia a conexão pro runtime, quando a env existe.
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
export { schema };
