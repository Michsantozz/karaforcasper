import { PostgresStore, PgVector } from "@mastra/pg";

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
  __mastraVector?: PgVector;
  __mastraStoreInit?: Promise<void>;
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

/**
 * Vector store for Memory semantic recall — pgvector in the SAME database
 * (DATABASE_URL), isolated in the `mastra` schema alongside the other Mastra
 * tables. Memory stores message embeddings here and queries them by similarity;
 * the embedder is Fireworks Qwen3-Embedding-8B (see createEmbedder). PgVector
 * auto-creates the index (4096-dim) on first upsert — no manual migration.
 *
 * Singleton for the same hot-reload/serverless reason as the store.
 */
export function getMastraVector(): PgVector {
  if (!globalForStore.__mastraVector) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL missing — Mastra vector store cannot start.");
    }
    globalForStore.__mastraVector = new PgVector({
      id: "casper-mastra-vector",
      schemaName: "mastra",
      connectionString,
    });
  }
  return globalForStore.__mastraVector;
}

/**
 * Runs `PostgresStore.init()` exactly ONCE per process, memoized as a shared
 * promise. `init()` runs schema DDL through a single PINNED backend connection
 * (RoutingDbClient.pin) and THROWS if a client is already pinned — so two
 * operations that each trigger a lazy first-time init concurrently collide with
 * "RoutingDbClient already has a pinned client". That happens as soon as a page
 * fires parallel memory calls on a cold store (e.g. the meeting notebook's
 * thread `initialize` + history `load` on mount). Awaiting this before the first
 * memory op serializes init so the pin/unpin never overlap. Idempotent: after
 * the first call it resolves instantly; on failure it clears so a retry re-inits.
 */
export function ensureMastraStoreInit(): Promise<void> {
  if (!globalForStore.__mastraStoreInit) {
    globalForStore.__mastraStoreInit = getMastraStore()
      .init()
      .catch((err) => {
        // Don't cache a failed init — let the next caller retry.
        globalForStore.__mastraStoreInit = undefined;
        throw err;
      });
  }
  return globalForStore.__mastraStoreInit;
}
