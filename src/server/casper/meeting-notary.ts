import "server-only";
import { createHash } from "node:crypto";
import { NativeTransferBuilder, PublicKey } from "casper-js-sdk";
import { CHAIN_NAME, getRpc, getAgentKey, getAgentPublicKeyHex } from "./client";

// Self-transfer, used only as a carrier for the meeting minutes fingerprint in
// the transfer id. The network requires a minimum transfer amount (2.5 CSPR
// on Testnet) — since the target is the agent itself, the amount returns to it.
const NOTARY_AMOUNT_MOTES = "2500000000"; // 2.5 CSPR (transfer minimum)
const NOTARY_PAYMENT_MOTES = 100_000_000; // ~0.1 CSPR gas

/**
 * The transfer id is a U64 (8 bytes) — the full SHA-256 (32 bytes) doesn't fit.
 * We derive a deterministic id from the first 8 bytes of the hash: it's the
 * on-chain index that links the tx to the meeting minutes. The full hash is
 * deterministic and reproducible from the minutes (hashMeetingRecord), so
 * verification recomputes the hash, derives the same id, and checks it against
 * the anchored id.
 */
// Exported for unit testing (critical on-chain decode logic, not just
// internal). Not part of the public API consumed by other layers.
export function hashToTransferId(meetingHash: string): number {
  // 13 hex digits ≈ 52 bits — comfortably fits in Number.MAX_SAFE_INTEGER.
  return Number.parseInt(meetingHash.slice(0, 13), 16);
}

/**
 * Decodes the anchored id: bytes "01<u64 little-endian>" (01 = Option::Some).
 * Reverses the 8 U64 bytes and converts to number.
 */
// Exported for unit testing (on-chain CLValue decode — critical).
export function decodeOptionU64LE(bytesHex: string): number | null {
  // Strips the Option prefix (01 = Some, 00 = None).
  if (!bytesHex || bytesHex.slice(0, 2).toLowerCase() === "00") return null;
  const le = bytesHex.slice(2); // 16 hex = 8 U64 bytes
  const pairs = le.match(/.{2}/g);
  if (!pairs) return null;
  const beHex = pairs.reverse().join(""); // little-endian → big-endian
  return Number(BigInt("0x" + beHex));
}

/** Minimal structure of the meeting minutes to be anchored. */
export interface MeetingRecord {
  botId: string;
  summary: string | null;
  decisions?: string[];
  actionItems?: { task: string; owner: string | null }[];
  participants?: string[];
  topics?: string[];
}

/**
 * Serializes the meeting minutes DETERMINISTICALLY (sorted keys) and computes
 * the SHA-256. Same minutes → same hash, regardless of field order — a
 * requirement for later verification to work.
 */
export function hashMeetingRecord(record: MeetingRecord): string {
  const canonical = JSON.stringify({
    actionItems: (record.actionItems ?? [])
      .map((a) => ({ owner: a.owner ?? "", task: a.task }))
      .sort((x, y) => (x.task < y.task ? -1 : x.task > y.task ? 1 : 0)),
    botId: record.botId,
    decisions: [...(record.decisions ?? [])].sort(),
    participants: [...(record.participants ?? [])].sort(),
    summary: record.summary ?? "",
    topics: [...(record.topics ?? [])].sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface NotarizeResult {
  meetingHash: string;
  transactionHash: string;
  notary: string;
  chainName: string;
  explorerUrl: string;
}

/**
 * Anchors the meeting minutes on Casper: builds a minimal self-transfer (1
 * mote) whose transfer id derives from the minutes' hash, signs it with the
 * AGENT's wallet, and submits it. Generates a real (tx-producing) transaction
 * — the immutable proof that the minutes existed in this state, linked
 * on-chain via the derived id.
 */
export async function notarizeMeeting(
  record: MeetingRecord,
): Promise<NotarizeResult> {
  const meetingHash = hashMeetingRecord(record);
  const key = await getAgentKey();
  const notary = await getAgentPublicKeyHex();
  const transferId = hashToTransferId(meetingHash);

  const tx = new NativeTransferBuilder()
    .from(key.publicKey)
    .target(PublicKey.fromHex(notary)) // to itself: anchoring only
    .amount(NOTARY_AMOUNT_MOTES)
    .id(transferId)
    .chainName(CHAIN_NAME)
    .payment(NOTARY_PAYMENT_MOTES)
    .build();

  tx.sign(key);
  const res = await getRpc().putTransaction(tx);
  const transactionHash = res.transactionHash.toHex();

  return {
    meetingHash,
    transactionHash,
    notary,
    chainName: CHAIN_NAME,
    explorerUrl: `https://testnet.cspr.live/deploy/${transactionHash}`,
  };
}

export interface VerifyResult {
  found: boolean;
  /** transfer id anchored on-chain in this tx (if found). */
  anchoredId: number | null;
  /** id derived from the provided minutes (if provided). */
  expectedId: number | null;
  /** Hash recomputed from the provided minutes (if provided). */
  recomputedHash: string | null;
  /** true when anchoredId === expectedId. */
  matches: boolean;
  transactionHash: string;
  explorerUrl: string;
}

/**
 * Verifies a notarization: reads the on-chain transaction by hash, extracts
 * the anchored transfer id, and, if the minutes are provided, derives the
 * expected id from the recomputed hash and compares them — proving (or
 * disproving) that those minutes correspond to the on-chain record.
 */
export async function verifyMeeting(args: {
  transactionHash: string;
  record?: MeetingRecord;
}): Promise<VerifyResult> {
  const explorerUrl = `https://testnet.cspr.live/deploy/${args.transactionHash}`;
  const recomputedHash = args.record ? hashMeetingRecord(args.record) : null;
  const expectedId = recomputedHash ? hashToTransferId(recomputedHash) : null;

  let anchoredId: number | null = null;
  try {
    const res = await getRpc().getTransactionByTransactionHash(
      args.transactionHash,
    );
    // The transfer's "id" arg serializes as ["id",{bytes:"01<u64 LE>",cl_type:
    // {Option:"U64"}}]. Extracts the bytes and decodes the little-endian U64
    // (first byte 01 = Option::Some).
    const blob = JSON.stringify(res.transaction.toJSON());
    const m = /"id"\s*,\s*\{\s*"bytes"\s*:\s*"([0-9a-f]+)"/i.exec(blob);
    anchoredId = m ? decodeOptionU64LE(m[1]) : null;
  } catch {
    return {
      found: false,
      anchoredId: null,
      expectedId,
      recomputedHash,
      matches: false,
      transactionHash: args.transactionHash,
      explorerUrl,
    };
  }

  return {
    found: anchoredId !== null,
    anchoredId,
    expectedId,
    recomputedHash,
    matches:
      anchoredId !== null && expectedId !== null && anchoredId === expectedId,
    transactionHash: args.transactionHash,
    explorerUrl,
  };
}
