import "server-only";
import { NativeTransferBuilder, Transaction, PublicKey } from "casper-js-sdk";
import { CHAIN_NAME, getRpc } from "./client";
import { withAlgorithmTag } from "./user-sign";

const MOTES_PER_CSPR = 1_000_000_000n;
const TRANSFER_PAYMENT_MOTES = 100_000_000;

// Exported for unit testing (money math — precision critical).
export function toMotes(amountCspr: number): string {
  return BigInt(Math.round(amountCspr * Number(MOTES_PER_CSPR))).toString();
}

function norm(hex: string): string {
  return hex.trim().toLowerCase();
}

/**
 * Reads the public keys (hex) that have already signed the tx, from the JSON.
 * Exported for unit testing.
 */
export function approvalSigners(transactionJson: string): string[] {
  try {
    const parsed = JSON.parse(transactionJson) as {
      approvals?: { signer?: string }[];
    };
    return (parsed.approvals ?? [])
      .map((a) => (a.signer ? norm(a.signer) : null))
      .filter((x): x is string => x !== null);
  } catch {
    return [];
  }
}

export interface MultisigState {
  transactionJson: string;
  /** Payer (where the funds come from) — must also be in signers. */
  from: string;
  to: string;
  amountCspr: string;
  /** All public keys that must sign. */
  signers: string[];
  /** How many signatures are required to submit (quorum). */
  threshold: number;
  /** Public keys that have already signed. */
  signed: string[];
  /** Public keys still missing. */
  pending: string[];
  /** Ready to broadcast? */
  ready: boolean;
  chainName: string;
}

// Exported for unit testing (quorum decision: ready = signed >= threshold).
export function buildState(
  transactionJson: string,
  meta: {
    from: string;
    to: string;
    amountCspr: string;
    signers: string[];
    threshold: number;
  },
): MultisigState {
  const signers = meta.signers.map(norm);
  const signed = approvalSigners(transactionJson).filter((s) =>
    signers.includes(s),
  );
  const pending = signers.filter((s) => !signed.includes(s));
  return {
    transactionJson,
    from: meta.from,
    to: meta.to,
    amountCspr: meta.amountCspr,
    signers,
    threshold: meta.threshold,
    signed,
    pending,
    ready: signed.length >= meta.threshold,
    chainName: CHAIN_NAME,
  };
}

/**
 * Builds (without signing) a payment that requires multiple signatures. The
 * tx itself is a native transfer from the payer `from`; the other signers'
 * signatures are accumulated as approvals before broadcast. `threshold`
 * defines the quorum (default: everyone).
 *
 * Note: for the NETWORK to accept N signatures from distinct keys, the payer
 * account needs those keys associated with weights (account multisig).
 * Without that setup, the tx carries the N approvals (demonstrable on-chain)
 * but only the owner's counts toward the network's threshold.
 */
export function prepareMultisigPayment(args: {
  fromPublicKeyHex: string;
  toPublicKeyHex: string;
  amountCspr: number;
  signerPublicKeysHex: string[];
  threshold?: number;
  transferId?: number;
}): MultisigState {
  const from = PublicKey.fromHex(args.fromPublicKeyHex);
  const target = PublicKey.fromHex(args.toPublicKeyHex);

  const tx = new NativeTransferBuilder()
    .from(from)
    .target(target)
    .amount(toMotes(args.amountCspr))
    .id(args.transferId ?? Date.now() % 1_000_000)
    .chainName(CHAIN_NAME)
    .payment(TRANSFER_PAYMENT_MOTES)
    .build();

  // Ensures the payer is among the signers.
  const signers = Array.from(
    new Set([norm(args.fromPublicKeyHex), ...args.signerPublicKeysHex.map(norm)]),
  );
  // Clamp: quorum between 1 and the number of signers. Without the floor of 1, a
  // threshold of 0/negative would leave `ready` always true (broadcast without a
  // signature). Same clamp as createSignatureRequest in signature-request.ts.
  const threshold = Math.min(
    Math.max(args.threshold ?? signers.length, 1),
    signers.length,
  );

  return buildState(JSON.stringify(tx.toJSON()), {
    from: args.fromPublicKeyHex,
    to: args.toPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    signers,
    threshold,
  });
}

/**
 * Attaches ONE signature (from sign_with_wallet) to the multisig tx and
 * returns the updated state. Idempotent per signer: re-signing doesn't duplicate.
 */
export function addMultisigApproval(args: {
  transactionJson: string;
  signatureHex: string;
  signerPublicKeyHex: string;
  meta: {
    from: string;
    to: string;
    amountCspr: string;
    signers: string[];
    threshold: number;
  };
}): MultisigState {
  const already = approvalSigners(args.transactionJson);
  if (already.includes(norm(args.signerPublicKeyHex))) {
    return buildState(args.transactionJson, args.meta);
  }

  const tx = Transaction.fromJSON(JSON.parse(args.transactionJson));
  const signer = PublicKey.fromHex(args.signerPublicKeyHex);
  const sig = withAlgorithmTag(args.signatureHex, args.signerPublicKeyHex);
  tx.setSignature(sig, signer); // pushes onto approvals[]

  return buildState(JSON.stringify(tx.toJSON()), args.meta);
}

export interface MultisigBroadcastResult {
  transactionHash: string;
  explorerUrl: string;
}

/** Submits the multisig tx (with approvals already accumulated) on-chain. */
export async function broadcastMultisig(
  transactionJson: string,
): Promise<MultisigBroadcastResult> {
  const tx = Transaction.fromJSON(JSON.parse(transactionJson));
  const res = await getRpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  return {
    transactionHash: hash,
    explorerUrl: `https://testnet.cspr.live/deploy/${hash}`,
  };
}
