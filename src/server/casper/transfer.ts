import "server-only";
import {
  NativeTransferBuilder,
  PublicKey,
  PurseIdentifier,
} from "casper-js-sdk";
import { CHAIN_NAME, getRpc, getAgentKey } from "./client";
import { assertTransferAllowed } from "./transfer-policy";

const MOTES_PER_CSPR = 1_000_000_000n;
// Gas de payment p/ transfer nativo no Testnet (~0.1 CSPR). Ajuste se a rede reclamar.
const TRANSFER_PAYMENT_MOTES = 100_000_000;

export interface TransferResult {
  transactionHash: string;
  amountCspr: string;
  to: string;
  chainName: string;
}

/**
 * Faz um transfer nativo de CSPR no Casper Testnet — assina e submete on-chain.
 * Este é o componente que GERA TRANSAÇÃO exigido pelo buildathon.
 */
export async function transferCspr(args: {
  toPublicKeyHex: string;
  amountCspr: number;
  transferId?: number;
}): Promise<TransferResult> {
  // Enforcement em código (teto + allowlist + fail-closed) ANTES de assinar.
  // Independe do prompt do agente e de qualquer aprovação no handler do chat.
  assertTransferAllowed({
    toPublicKeyHex: args.toPublicKeyHex,
    amountCspr: args.amountCspr,
  });

  const key = await getAgentKey();
  const target = PublicKey.fromHex(args.toPublicKeyHex);
  const amountMotes = BigInt(Math.round(args.amountCspr * Number(MOTES_PER_CSPR)));

  const tx = new NativeTransferBuilder()
    .from(key.publicKey)
    .target(target)
    .amount(amountMotes.toString())
    .id(args.transferId ?? Date.now() % 1_000_000)
    .chainName(CHAIN_NAME)
    .payment(TRANSFER_PAYMENT_MOTES)
    .build();

  tx.sign(key); // muta in-place: adiciona approval
  const res = await getRpc().putTransaction(tx);

  return {
    transactionHash: res.transactionHash.toHex(),
    amountCspr: args.amountCspr.toString(),
    to: args.toPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

/** Consulta saldo (em CSPR) de uma public key. Read-only, sem tx. */
export async function getBalanceCspr(publicKeyHex: string): Promise<string> {
  const pk = PublicKey.fromHex(publicKeyHex);
  try {
    const res = await getRpc().queryLatestBalance(
      PurseIdentifier.fromPublicKey(pk),
    );
    const motes = BigInt(res.balance.toString());
    return (Number(motes) / Number(MOTES_PER_CSPR)).toString();
  } catch (e) {
    // "Purse not found" = carteira ainda sem fundos no Testnet.
    if (e instanceof Error && /purse not found/i.test(e.message)) return "0";
    throw e;
  }
}
