import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, isNotNull } from "drizzle-orm";
import { PublicKey } from "casper-js-sdk";
import { db } from "@/shared/db";
import {
  userWallets,
  walletLinkNonces,
  type UserWalletRow,
} from "@/shared/db/schema";
import { withAlgorithmTag } from "./user-sign";

/**
 * Casper wallets linked to app users.
 *
 * Serves two purposes in the multisig flow:
 *  - resolving wallet → user, to notify in-app the signers who have an account;
 *  - building the "awaiting my signature" dashboard (match by publicKeyHex).
 *
 * Linking requires PROOF OF POSSESSION (SIWE-style): the user signs a nonce
 * with the key and the server verifies the signature before persisting.
 * Without this, anyone could link someone else's pubkey. publicKeyHex is
 * always normalized (lowercase).
 */

function norm(hex: string): string {
  return hex.trim().toLowerCase();
}

// ED25519: 01 + 64 hex (32 bytes). SECP256K1: 02 + 66 hex (33 bytes).
const VALID_PUBKEY = /^(?:01[0-9a-f]{64}|02[0-9a-f]{66})$/;
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 min

/** Validates the format of a Casper public key (ED25519 or SECP256K1). */
export function isValidPublicKeyHex(hex: string): boolean {
  return VALID_PUBKEY.test(norm(hex));
}

/**
 * The Casper Wallet signs messages by prefixing the header "Casper Message:\n".
 * To verify a nonce's signature, we reconstruct the same message.
 */
function casperMessageBytes(message: string): Uint8Array {
  return new TextEncoder().encode(`Casper Message:\n${message}`);
}

/**
 * Cryptographically verifies that `signatureHex` was produced by
 * `publicKeyHex` over `message` (Casper Wallet's signMessage format).
 * The wallet's signature is raw (64 bytes); the SDK expects the algorithm tag.
 */
export function verifyMessageSignature(args: {
  message: string;
  publicKeyHex: string;
  signatureHex: string;
}): boolean {
  try {
    const pub = PublicKey.fromHex(args.publicKeyHex);
    // The SDK's verifySignature expects the signature WITH the algorithm tag
    // (65 bytes: 01/02 + 64 raw). The Casper Wallet returns the raw signature
    // (64 bytes), so withAlgorithmTag prefixes the tag based on the pubkey's curve.
    const tagged = withAlgorithmTag(args.signatureHex, args.publicKeyHex);
    return pub.verifySignature(casperMessageBytes(args.message), tagged);
  } catch {
    return false;
  }
}

/**
 * Issues a single-use nonce (5 min) for the user to prove possession of a
 * wallet. The client signs this nonce (signMessage) and returns the signature.
 */
export async function createWalletLinkNonce(userId: string): Promise<string> {
  const nonce = `Link wallet to CasperAgent — ${randomUUID()}`;
  await db.insert(walletLinkNonces).values({
    nonce,
    userId,
    expiresAt: new Date(Date.now() + NONCE_TTL_MS),
  });
  return nonce;
}

/**
 * Consumes a nonce: validates that it exists, belongs to the user, hasn't
 * expired, and hasn't been used. Marks it as consumed. Throws on violation.
 */
async function consumeNonce(nonce: string, userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(walletLinkNonces)
    .where(eq(walletLinkNonces.nonce, nonce))
    .limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) throw new Error("invalid_nonce");
  if (row.consumedAt) throw new Error("nonce_already_used");
  if (row.expiresAt.getTime() < Date.now()) throw new Error("nonce_expired");
  await db
    .update(walletLinkNonces)
    .set({ consumedAt: new Date() })
    .where(eq(walletLinkNonces.nonce, nonce));
}

/**
 * Links a wallet to a user WITH PROOF OF POSSESSION.
 *
 * Requires: the `nonce` issued by createWalletLinkNonce + the `signatureHex`
 * of that nonce signed by the wallet. Cryptographically verifies
 * (verifyMessageSignature) that the signature matches the publicKey before
 * persisting. Sets verifiedAt. Idempotent per (userId, publicKeyHex). Throws
 * on invalid proof.
 */
export async function linkWallet(input: {
  userId: string;
  publicKeyHex: string;
  nonce: string;
  signatureHex: string;
  label?: string | null;
}): Promise<void> {
  if (!isValidPublicKeyHex(input.publicKeyHex)) {
    throw new Error("invalid_public_key");
  }
  // Consumes the nonce (single-use, belonging to this user, not expired).
  await consumeNonce(input.nonce, input.userId);
  // Proof of possession: the nonce's signature must match the publicKey.
  const ok = verifyMessageSignature({
    message: input.nonce,
    publicKeyHex: input.publicKeyHex,
    signatureHex: input.signatureHex,
  });
  if (!ok) throw new Error("proof_failed");

  await db
    .insert(userWallets)
    .values({
      id: randomUUID(),
      userId: input.userId,
      publicKeyHex: norm(input.publicKeyHex),
      label: input.label ?? null,
      verifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userWallets.userId, userWallets.publicKeyHex],
      set: { label: input.label ?? null, verifiedAt: new Date() },
    });
}

/** Removes a user's wallet link. */
export async function unlinkWallet(
  userId: string,
  publicKeyHex: string,
): Promise<void> {
  await db
    .delete(userWallets)
    .where(
      and(
        eq(userWallets.userId, userId),
        eq(userWallets.publicKeyHex, norm(publicKeyHex)),
      ),
    );
}

/** VERIFIED wallets linked to a user. */
export async function listWalletsByUser(
  userId: string,
): Promise<UserWalletRow[]> {
  return db
    .select()
    .from(userWallets)
    .where(
      and(eq(userWallets.userId, userId), isNotNull(userWallets.verifiedAt)),
    );
}

/**
 * Resolves wallet → userId (VERIFIED link), or null. Used for notifications.
 * Only wallets with proven possession count.
 */
export async function resolveUserByWallet(
  publicKeyHex: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(userWallets)
    .where(
      and(
        eq(userWallets.publicKeyHex, norm(publicKeyHex)),
        isNotNull(userWallets.verifiedAt),
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Resolves a batch of wallets → map of publicKeyHex(normalized) → userId.
 * Only includes VERIFIED links. Used when creating a request to notify, in
 * one shot, all signers who have an account with proven possession.
 */
export async function resolveUsersByWallets(
  publicKeysHex: string[],
): Promise<Map<string, string>> {
  const keys = publicKeysHex.map(norm);
  if (keys.length === 0) return new Map();

  const rows = await db
    .select()
    .from(userWallets)
    .where(
      and(
        inArray(userWallets.publicKeyHex, keys),
        isNotNull(userWallets.verifiedAt),
      ),
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.publicKeyHex)) map.set(row.publicKeyHex, row.userId);
  }
  return map;
}

/** Sweeps expired/consumed nonces (housekeeping, called by the cron). */
export async function sweepExpiredNonces(): Promise<void> {
  await db
    .delete(walletLinkNonces)
    .where(lt(walletLinkNonces.expiresAt, new Date()));
}
