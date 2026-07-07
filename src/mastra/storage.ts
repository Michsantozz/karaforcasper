import { PostgresStore } from "@mastra/pg";

/**
 * Storage Postgres compartilhado do Mastra — MESMO banco do app (DATABASE_URL,
 * PG :5434). O Mastra cria/gerencia as próprias tabelas (mastra_*) neste banco,
 * separadas das tabelas do app (user/session/signature_requests/…).
 *
 * Usado em dois lugares:
 *  - new Mastra({ storage }) → persiste traces, telemetria e estado de workflows
 *    (essencial para o loop autônomo/cron não perder contexto entre execuções).
 *  - new Memory({ storage })  → persiste threads/mensagens dos agents, para o
 *    agente LEMBRAR de conversas anteriores.
 *
 * Singleton: evita abrir múltiplos pools em hot-reload (dev) / serverless.
 */
const globalForStore = globalThis as unknown as {
  __mastraStore?: PostgresStore;
};

export function getMastraStore(): PostgresStore {
  if (!globalForStore.__mastraStore) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL ausente — storage do Mastra não pode subir.");
    }
    globalForStore.__mastraStore = new PostgresStore({
      id: "casper-mastra",
      // Isola as tabelas do Mastra num schema próprio — não polui o `public`
      // onde vivem as tabelas do app (user/session/signature_requests/…).
      schemaName: "mastra",
      connectionString,
    });
  }
  return globalForStore.__mastraStore;
}
