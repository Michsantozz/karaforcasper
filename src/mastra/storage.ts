import { PostgresStore } from "@mastra/pg";

/**
 * Shared Postgres storage for Mastra — the SAME database as the app (DATABASE_URL,
 * PG :5434). Mastra creates/manages its own tables (mastra_*) in this database,
 * separate from the app's tables (user/session/signature_requests/…).
 *
 * Used in two places:
 *  - new Mastra({ storage }) → persists traces, telemetry and workflow state
 *    (essential so the autonomous loop/cron doesn't lose context between runs).
 *  - new Memory({ storage })  → persists agent threads/messages, so the
 *    agent REMEMBERS previous conversations.
 *
 * Singleton: avoids opening multiple pools on hot-reload (dev) / serverless.
 */
const globalForStore = globalThis as unknown as {
  __mastraStore?: PostgresStore;
};

export function getMastraStore(): PostgresStore {
  if (!globalForStore.__mastraStore) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL missing — Mastra storage cannot start.");
    }
    globalForStore.__mastraStore = new PostgresStore({
      id: "casper-mastra",
      // Isolates Mastra's tables in their own schema — doesn't pollute `public`
      // where the app's tables live (user/session/signature_requests/…).
      schemaName: "mastra",
      connectionString,
    });
  }
  return globalForStore.__mastraStore;
}
