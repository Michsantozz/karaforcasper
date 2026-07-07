import "server-only";
import { getRpc, getAgentPublicKeyHex } from "./client";
import { creditDeposit, MOTES_PER_CSPR } from "./billing";

/**
 * Verificação de depósito on-chain → crédito no ledger.
 *
 * O usuário deposita CSPR transferindo para a CONTA DO APP (public key do
 * agente) pela própria carteira. Este módulo lê a transação pelo hash, confirma
 * que os fundos chegaram ao app e credita o ledger — idempotente por txHash, de
 * modo que reenviar o mesmo hash não credita duas vezes.
 *
 * Confiamos apenas no que está on-chain: valor e destino vêm da transação lida
 * do nó, nunca de parâmetros do cliente (que só informa qual tx conferir).
 */

export interface VerifyDepositResult {
  credited: boolean;
  reason?: string;
  amountMotes?: string;
  amountCspr?: string;
}

/** Extrai o valor (motes) do arg "amount" (U512) de um transfer serializado. */
function extractAmountMotes(blob: string): bigint | null {
  // "amount",{"bytes":"<len><u512 LE>","cl_type":"U512"} — o U512 é little-endian
  // com 1 byte de comprimento no início. Decodificamos genericamente.
  const m = /"amount"\s*,\s*\{\s*"bytes"\s*:\s*"([0-9a-f]+)"/i.exec(blob);
  if (!m) return null;
  return decodeU512LE(m[1]);
}

/** Decodifica um U512 CLValue (1 byte de len + bytes little-endian). */
function decodeU512LE(bytesHex: string): bigint | null {
  if (bytesHex.length < 2) return null;
  const len = parseInt(bytesHex.slice(0, 2), 16);
  if (Number.isNaN(len) || len === 0) return 0n;
  const body = bytesHex.slice(2, 2 + len * 2);
  const pairs = body.match(/.{2}/g);
  if (!pairs) return null;
  const beHex = pairs.reverse().join(""); // little-endian → big-endian
  return BigInt("0x" + beHex);
}

/**
 * Verifica e credita um depósito pelo hash da transação. Confere que a tx
 * referencia a conta do app como destino (public key do agente aparece no
 * corpo), extrai o valor transferido e credita o usuário.
 */
export async function verifyAndCreditDeposit(args: {
  txHash: string;
  userId: string;
}): Promise<VerifyDepositResult> {
  const appPubKey = (await getAgentPublicKeyHex()).toLowerCase();

  let blob: string;
  try {
    const res = await getRpc().getTransactionByTransactionHash(args.txHash);
    blob = JSON.stringify(res.transaction.toJSON()).toLowerCase();
  } catch {
    return { credited: false, reason: "transaction not found on-chain" };
  }

  // O destino tem que ser a conta do app — senão o depósito não chegou a nós.
  if (!blob.includes(appPubKey)) {
    return { credited: false, reason: "transfer target is not the app account" };
  }

  const amountMotes = extractAmountMotes(blob);
  if (amountMotes == null || amountMotes <= 0n) {
    return { credited: false, reason: "could not read transfer amount" };
  }

  const credited = await creditDeposit({
    txHash: args.txHash,
    userId: args.userId,
    amountMotes,
  });

  return {
    credited,
    reason: credited ? undefined : "deposit already credited",
    amountMotes: amountMotes.toString(),
    amountCspr: (Number(amountMotes) / Number(MOTES_PER_CSPR)).toString(),
  };
}
