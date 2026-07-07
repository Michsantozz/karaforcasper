import "server-only";
import {
  NativeTransferBuilder,
  PublicKey,
  PurseIdentifier,
} from "casper-js-sdk";
import { CHAIN_NAME, getRpc, getAgentKey } from "./client";
import { assertTransferAllowed } from "./transfer-policy";

const MOTES_PER_CSPR = 1_000_000_000n;
// Payment gas for a native transfer on Testnet (~0.1 CSPR). Adjust if the network complains.
const TRANSFER_PAYMENT_MOTES = 100_000_000;

export interface TransferResult {
  transactionHash: string;
  amountCspr: string;
  to: string;
  chainName: string;
}

/**
 * Performs a native CSPR transfer on Casper Testnet — signs and submits on-chain.
 * This is the transaction-generating component required by the buildathon.
 */
export async function transferCspr(args: {
  toPublicKeyHex: string;
  amountCspr: number;
  transferId?: number;
}): Promise<TransferResult> {
  // Enforcement in code (cap + allowlist + fail-closed) BEFORE signing.
  // Independent of the agent's prompt and of any approval in the chat handler.
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

  tx.sign(key); // mutates in-place: adds approval
  const res = await getRpc().putTransaction(tx);

  return {
    transactionHash: res.transactionHash.toHex(),
    amountCspr: args.amountCspr.toString(),
    to: args.toPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

/** Queries the balance (in CSPR) of a public key. Read-only, no tx. */
export async function getBalanceCspr(publicKeyHex: string): Promise<string> {
  const pk = PublicKey.fromHex(publicKeyHex);
  try {
    const res = await getRpc().queryLatestBalance(
      PurseIdentifier.fromPublicKey(pk),
    );
    const motes = BigInt(res.balance.toString());
    return (Number(motes) / Number(MOTES_PER_CSPR)).toString();
  } catch (e) {
    // "Purse not found" = wallet still has no funds on Testnet.
    if (e instanceof Error && /purse not found/i.test(e.message)) return "0";
    throw e;
  }
}
