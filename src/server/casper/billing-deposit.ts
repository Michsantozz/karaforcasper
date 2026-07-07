import "server-only";
import { getRpc, getAgentPublicKeyHex } from "./client";
import { creditDeposit, MOTES_PER_CSPR } from "./billing";
import { approvalSigners } from "./multisig";
import { resolveUserByWallet } from "./user-wallets";

/**
 * On-chain deposit verification → ledger credit.
 *
 * The user deposits CSPR by transferring to the APP ACCOUNT (agent's public
 * key) from their own wallet. This module reads the transaction by hash,
 * confirms the funds reached the app, and credits the ledger — idempotent by
 * txHash, so resubmitting the same hash doesn't credit twice.
 *
 * We trust only what's on-chain: amount, target, AND SENDER come from the
 * transaction read from the node, never from client parameters (which only
 * tell us which tx to check). The sender (whoever signed the tx) must be a
 * VERIFIED wallet of the user themself — otherwise any authenticated user
 * could credit someone else's deposit to themselves just by supplying the
 * public txHash (deposit hijack).
 */

export interface VerifyDepositResult {
  credited: boolean;
  reason?: string;
  amountMotes?: string;
  amountCspr?: string;
}

/** Extracts the value (motes) from the "amount" arg (U512) of a serialized transfer. */
function extractAmountMotes(blob: string): bigint | null {
  // "amount",{"bytes":"<len><u512 LE>","cl_type":"U512"} — U512 is
  // little-endian with 1 length byte at the start. Decoded generically.
  const m = /"amount"\s*,\s*\{\s*"bytes"\s*:\s*"([0-9a-f]+)"/i.exec(blob);
  if (!m) return null;
  return decodeU512LE(m[1]);
}

/** Decodes a U512 CLValue (1 length byte + little-endian bytes). */
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
 * Verifies and credits a deposit by the transaction hash. Checks that the tx
 * references the app account as the target (agent's public key appears in
 * the body), extracts the transferred amount, and credits the user.
 */
export async function verifyAndCreditDeposit(args: {
  txHash: string;
  userId: string;
}): Promise<VerifyDepositResult> {
  const appPubKey = (await getAgentPublicKeyHex()).toLowerCase();

  let rawBlob: string;
  try {
    const res = await getRpc().getTransactionByTransactionHash(args.txHash);
    rawBlob = JSON.stringify(res.transaction.toJSON());
  } catch {
    return { credited: false, reason: "transaction not found on-chain" };
  }
  const blob = rawBlob.toLowerCase();

  // The target must be the app account — otherwise the deposit didn't reach us.
  if (!blob.includes(appPubKey)) {
    return { credited: false, reason: "transfer target is not the app account" };
  }

  // The sender (whoever SIGNED the on-chain tx) must be a verified wallet OF
  // THIS user. Without this, any authenticated user could credit someone
  // else's deposit to themselves by supplying the public txHash. The
  // signature is the source of truth for who paid — we don't trust any field
  // from the request body.
  const signers = approvalSigners(rawBlob);
  if (signers.length === 0) {
    return { credited: false, reason: "could not read transaction sender" };
  }
  const senderOwners = await Promise.all(signers.map(resolveUserByWallet));
  if (!senderOwners.includes(args.userId)) {
    return {
      credited: false,
      reason: "sender wallet is not a verified wallet of this user",
    };
  }

  const amountMotes = extractAmountMotes(blob);
  if (amountMotes == null || amountMotes <= 0n) {
    return { credited: false, reason: "could not read transfer amount" };
  }

  // Records the source wallet (first signer) for the audit trail.
  const credited = await creditDeposit({
    txHash: args.txHash,
    userId: args.userId,
    amountMotes,
    fromPublicKey: signers[0],
  });

  return {
    credited,
    reason: credited ? undefined : "deposit already credited",
    amountMotes: amountMotes.toString(),
    amountCspr: (Number(amountMotes) / Number(MOTES_PER_CSPR)).toString(),
  };
}
