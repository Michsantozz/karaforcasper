import "server-only";
import { randomUUID } from "node:crypto";

/**
 * In-memory store of transactions pending signature.
 *
 * Reason: the JSON of a transaction (especially session/wasm, ~14KB) is too
 * large to travel as a tool argument through the LLM — the model
 * truncates/corrupts the text, and the signature silently fails. Instead,
 * the server holds the JSON and exposes a short ID; the model only passes
 * along the ID, and the client fetches the full JSON via /api/tx/:id at
 * signing time.
 *
 * Not durable (lost on restart) — suited to the ephemeral signing flow.
 * Entries expire so as not to leak memory.
 */
const TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Human-readable metadata of the tx, shown to the user BEFORE signing so they
 * know what they're approving. Independent of whatever the LLM passes as args.
 */
export interface TxMeta {
  kind?: string; // e.g.: "transfer", "delegate", "undelegate", "setup_multisig"
  amountCspr?: string;
  from?: string;
  to?: string;
}

interface Entry {
  json: string;
  meta?: TxMeta;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [id, e] of store) {
    if (e.expiresAt < now) store.delete(id);
  }
}

/** Holds the tx JSON (+ human-readable metadata) and returns a short ID. */
export function putTx(json: string, meta?: TxMeta): string {
  sweep();
  const id = randomUUID().slice(0, 8);
  store.set(id, { json, meta, expiresAt: Date.now() + TTL_MS });
  return id;
}

/** Retrieves the full JSON by ID. */
export function getTx(id: string): string | null {
  return getEntry(id)?.json ?? null;
}

/** Retrieves the human-readable metadata by ID (to display before signing). */
export function getTxMeta(id: string): TxMeta | null {
  return getEntry(id)?.meta ?? null;
}

function getEntry(id: string): Entry | null {
  const e = store.get(id);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    store.delete(id);
    return null;
  }
  return e;
}
