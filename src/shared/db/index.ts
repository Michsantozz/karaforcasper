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

export const db = drizzle(getPool(), { schema });
export { schema };
