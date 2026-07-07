import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Store em memória de transações pendentes de assinatura.
 *
 * Motivo: o JSON de uma transação (sobretudo session/wasm, ~14KB) é grande
 * demais para trafegar como argumento de tool pelo LLM — o modelo trunca/corrompe
 * o texto, e a assinatura falha silenciosamente. Em vez disso, o servidor guarda
 * o JSON e expõe um ID curto; o modelo só repassa o ID, e o cliente busca o JSON
 * íntegro via /api/tx/:id na hora de assinar.
 *
 * Não é durável (perde no restart) — adequado para o fluxo efêmero de
 * assinatura. Entradas expiram para não vazar memória.
 */
const TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Metadados legíveis da tx, exibidos ao usuário ANTES de assinar para que ele
 * saiba o que está aprovando. Independente do que o LLM repassa como args.
 */
export interface TxMeta {
  kind?: string; // ex: "transfer", "delegate", "undelegate", "setup_multisig"
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

/** Guarda o JSON da tx (+ metadados legíveis) e retorna um ID curto. */
export function putTx(json: string, meta?: TxMeta): string {
  sweep();
  const id = randomUUID().slice(0, 8);
  store.set(id, { json, meta, expiresAt: Date.now() + TTL_MS });
  return id;
}

/** Recupera o JSON íntegro pelo ID. */
export function getTx(id: string): string | null {
  return getEntry(id)?.json ?? null;
}

/** Recupera os metadados legíveis pelo ID (para exibir antes de assinar). */
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
