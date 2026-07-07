import "server-only";
import {
  NativeTransferBuilder,
  NativeDelegateBuilder,
  NativeUndelegateBuilder,
  Transaction,
  PublicKey,
} from "casper-js-sdk";
import { Buffer } from "node:buffer";
import { CHAIN_NAME, getRpc } from "./client";

const MOTES_PER_CSPR = 1_000_000_000n;
// Payment gas for a native transfer on Testnet (~0.1 CSPR).
const TRANSFER_PAYMENT_MOTES = 100_000_000;
// Payment gas for delegate/undelegate (~2.5 CSPR — an auction operation).
const STAKING_PAYMENT_MOTES = 2_500_000_000;

function toMotes(amountCspr: number): string {
  return BigInt(Math.round(amountCspr * Number(MOTES_PER_CSPR))).toString();
}

// Algorithm tag (= public key prefix): 01 = ED25519, 02 = SECP256K1.
// The Casper Wallet returns the raw signature (64 bytes); the node requires
// the tag as the first byte. Prefixes it if not already present (idempotent).
export function withAlgorithmTag(
  signatureHex: string,
  signerPublicKeyHex: string,
): Uint8Array {
  const raw = Uint8Array.from(Buffer.from(signatureHex, "hex"));
  const tag = signerPublicKeyHex.slice(0, 2).toLowerCase() === "01" ? 0x01 : 0x02;
  // 64 bytes = raw signature (needs tag); 65 = already prefixed.
  if (raw.length === 65 && (raw[0] === 0x01 || raw[0] === 0x02)) return raw;
  const tagged = new Uint8Array(raw.length + 1);
  tagged[0] = tag;
  tagged.set(raw, 1);
  return tagged;
}

export interface PreparedUserTransfer {
  /** Tx JSON (unsigned) — sent to the client for the Casper Wallet to sign. */
  transactionJson: string;
  /** Public key (hex) that MUST sign — the active account in the user's wallet. */
  signerPublicKeyHex: string;
  amountCspr: string;
  to: string;
  chainName: string;
}

/**
 * Builds a native CSPR transfer from the USER's wallet (not the agent's) —
 * without signing. The resulting JSON goes to the browser, where the Casper
 * Wallet extension signs it (popup). The signature comes back and is attached
 * in broadcastUserSignedTransfer.
 */
export function prepareUserTransfer(args: {
  fromPublicKeyHex: string;
  toPublicKeyHex: string;
  amountCspr: number;
  transferId?: number;
}): PreparedUserTransfer {
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

  return {
    transactionJson: JSON.stringify(tx.toJSON()),
    signerPublicKeyHex: args.fromPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    to: args.toPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

export interface PreparedUserStaking {
  /** Tx JSON (unsigned) — sent to the client for the wallet to sign. */
  transactionJson: string;
  signerPublicKeyHex: string;
  amountCspr: string;
  /** Validator's public key (delegate/undelegate). */
  validator: string;
  chainName: string;
}

/**
 * Builds (without signing) a CSPR delegation from the USER's wallet to a
 * validator. Staking generates rewards. The JSON goes to the browser for signing.
 */
export function prepareUserDelegate(args: {
  fromPublicKeyHex: string;
  validatorPublicKeyHex: string;
  amountCspr: number;
}): PreparedUserStaking {
  const from = PublicKey.fromHex(args.fromPublicKeyHex);
  const validator = PublicKey.fromHex(args.validatorPublicKeyHex);

  const tx = new NativeDelegateBuilder()
    .from(from)
    .validator(validator)
    .amount(toMotes(args.amountCspr))
    .chainName(CHAIN_NAME)
    .payment(STAKING_PAYMENT_MOTES)
    .build();

  return {
    transactionJson: JSON.stringify(tx.toJSON()),
    signerPublicKeyHex: args.fromPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    validator: args.validatorPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

/**
 * Builds (without signing) the redemption (undelegate) of CSPR previously
 * staked from the USER's wallet with a validator. The JSON goes to the
 * browser for signing.
 */
export function prepareUserUndelegate(args: {
  fromPublicKeyHex: string;
  validatorPublicKeyHex: string;
  amountCspr: number;
}): PreparedUserStaking {
  const from = PublicKey.fromHex(args.fromPublicKeyHex);
  const validator = PublicKey.fromHex(args.validatorPublicKeyHex);

  const tx = new NativeUndelegateBuilder()
    .from(from)
    .validator(validator)
    .amount(toMotes(args.amountCspr))
    .chainName(CHAIN_NAME)
    .payment(STAKING_PAYMENT_MOTES)
    .build();

  return {
    transactionJson: JSON.stringify(tx.toJSON()),
    signerPublicKeyHex: args.fromPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    validator: args.validatorPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

export interface BroadcastResult {
  transactionHash: string;
  explorerUrl: string;
}

/**
 * Receives the tx JSON (the same one prepareUserTransfer emitted) + the hex
 * signature produced by the user's wallet. Attaches the approval and submits on-chain.
 */
export async function broadcastUserSignedTransfer(args: {
  transactionJson: string;
  signatureHex: string;
  signerPublicKeyHex: string;
}): Promise<BroadcastResult> {
  const tx = Transaction.fromJSON(JSON.parse(args.transactionJson));
  const signer = PublicKey.fromHex(args.signerPublicKeyHex);

  // The Casper Wallet returns the RAW signature (64 bytes, no algorithm
  // byte). The node/SDK expect the signature prefixed with the curve tag:
  // 01 = ED25519, 02 = SECP256K1 — the same tag that prefixes the public key.
  const sig = withAlgorithmTag(args.signatureHex, args.signerPublicKeyHex);
  tx.setSignature(sig, signer);

  const res = await getRpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  return {
    transactionHash: hash,
    explorerUrl: `https://testnet.cspr.live/deploy/${hash}`,
  };
}
