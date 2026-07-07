import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, isNull, gt, sql } from "drizzle-orm";
import { Transaction, PublicKey } from "casper-js-sdk";
import { db } from "@/shared/db";
import {
  signatureRequests,
  signatureApprovals,
  type SignatureRequestRow,
  type SignatureApprovalRow,
  type RequiredSigner,
  type SignatureRequestStatus,
} from "@/shared/db/schema";
import { CHAIN_NAME, getRpc } from "./client";
import { withAlgorithmTag } from "./user-sign";

/**
 * Distributed signature collection layer (SaaS multisig).
 *
 * Persists a request (base tx + signers + quorum) and accumulates the
 * signatures as rows in signature_approvals — one per signer, with
 * idempotency guaranteed by the unique (requestId, signerPublicKeyHex) in the schema.
 *
 * Difference from multisig.ts (in-memory): here the state is durable and each
 * approval is a record. The tx serialized in the request is the BASE (no
 * approvals); only at broadcast time do we rebuild the tx accumulating each
 * signature via addMultisigApproval — reusing exactly the already-validated path.
 *
 * Enforcement: see the note in the schema — the network only honors N
 * signatures if the payer account is a native multisig (multisig-setup.ts).
 * This layer collects; the threshold here is the PRODUCT's quorum, not
 * necessarily the network's.
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TX_JSON_BYTES = 64_000;
// The Casper testnet (Condor 2.0) rejects a native transfer below this
// minimum with "insufficient transfer amount" (-32016). We validate at
// creation time to avoid persisting a request that could never be broadcast.
const MIN_TRANSFER_CSPR = 2.5;

function norm(hex: string): string {
  return hex.trim().toLowerCase();
}

/**
 * Validates that `transactionJson` is a well-formed (parseable) Casper tx and
 * within the size limit. Throws on violation. Used when creating the request
 * to avoid persisting garbage.
 */
export function assertValidTransactionJson(transactionJson: string): void {
  if (transactionJson.length > MAX_TX_JSON_BYTES) {
    throw new Error("transaction_too_large");
  }
  try {
    Transaction.fromJSON(JSON.parse(transactionJson));
  } catch {
    throw new Error("invalid_transaction_json");
  }
  // Rejects transfers below the network minimum early (otherwise the request
  // gets stuck in "ready" and blows up at broadcast). Best-effort: only
  // validates if the amount was decoded.
  const { amountCspr } = decodeTransfer(transactionJson);
  if (amountCspr != null && Number(amountCspr) < MIN_TRANSFER_CSPR) {
    throw new Error("transfer_below_minimum");
  }
}

export interface DecodedTransfer {
  /** Real amount in CSPR (decoded from the tx, not from the description). */
  amountCspr: string | null;
  /** Real target (account-hash or pubkey) decoded from the tx. */
  target: string | null;
}

/**
 * Decodes the REAL amount and target of a transfer tx from the serialized
 * JSON — so the signer sees what they're signing, independent of the
 * `description` (which the creator could falsify). Best-effort: fields vary
 * by SDK version; returns null for what it can't extract.
 */
export function decodeTransfer(transactionJson: string): DecodedTransfer {
  try {
    const tx = Transaction.fromJSON(JSON.parse(transactionJson));
    // Typed native-transfer args (Transaction 2.0): the V1 carries
    // payload.fields.args (Args), from which we read the already-deserialized
    // 'amount'/'target' CLValues — not the raw JSON bytes.
    const v1 = (
      tx as unknown as {
        getTransactionV1?: () => {
          payload?: { fields?: { args?: { getByName?: (n: string) => unknown } } };
        };
      }
    ).getTransactionV1?.();
    const args = v1?.payload?.fields?.args;
    if (!args?.getByName) return { amountCspr: null, target: null };

    const amountCl = args.getByName("amount") as
      | { toString(): string }
      | undefined;
    const targetCl = args.getByName("target") as
      | { toString(): string }
      | undefined;

    const amountMotes = amountCl?.toString();
    const target = targetCl?.toString() ?? null;
    const amountCspr =
      amountMotes != null && amountMotes !== ""
        ? (Number(amountMotes) / 1_000_000_000).toString()
        : null;
    return { amountCspr, target };
  } catch {
    return { amountCspr: null, target: null };
  }
}

/**
 * CRYPTOGRAPHICALLY verifies that `signatureHex` is a valid signature by
 * `signerPublicKeyHex` over the base tx. Rebuilds the tx, attaches the
 * signature, and calls tx.validate() — the SDK checks each approval against
 * the tx hash (ErrInvalidApprovalSignature on a forged signature). Returns true/false.
 *
 * This blocks forged signatures BEFORE broadcast (without spending gas on the network).
 */
function verifyTxSignature(args: {
  transactionJson: string;
  signerPublicKeyHex: string;
  signatureHex: string;
}): boolean {
  try {
    const tx = Transaction.fromJSON(JSON.parse(args.transactionJson));
    const signer = PublicKey.fromHex(args.signerPublicKeyHex);
    const sig = withAlgorithmTag(args.signatureHex, args.signerPublicKeyHex);
    tx.setSignature(sig, signer);
    tx.validate(); // throws if any approval doesn't match the hash
    return true;
  } catch {
    return false;
  }
}

export interface SignatureRequestState {
  request: SignatureRequestRow;
  approvals: SignatureApprovalRow[];
  /** Public keys (normalized) that have already signed. */
  signed: string[];
  /** Required public keys still missing. */
  pending: string[];
  /** Reached quorum (>= threshold valid signatures)? */
  ready: boolean;
}

/** Required public keys (normalized) from the request's jsonb. */
function requiredKeys(request: SignatureRequestRow): string[] {
  return request.requiredSigners.map((s) => norm(s.publicKeyHex));
}

/**
 * Derives the state (signed/pending/ready) from the persisted approvals.
 * Exported for unit testing — it's the quorum decision before broadcast.
 */
export function deriveState(
  request: SignatureRequestRow,
  approvals: SignatureApprovalRow[],
): SignatureRequestState {
  const required = requiredKeys(request);
  // Only counts approvals from REQUIRED signers (defense against noise).
  const signed = approvals
    .map((a) => norm(a.signerPublicKeyHex))
    .filter((k) => required.includes(k));
  const signedSet = new Set(signed);
  const pending = required.filter((k) => !signedSet.has(k));

  return {
    request,
    approvals,
    signed,
    pending,
    ready: signedSet.size >= request.threshold,
  };
}

export interface SignerNotificationPlan {
  /** Signers with a linked wallet → notify in-app + email by userId. */
  accountUserIds: string[];
  /** Emails of signers WITHOUT an account → direct invite (deduplicated). */
  externalEmails: string[];
}

/**
 * Decides WHO gets notified when a request is created, with no overlap:
 *  - accountUserIds: signers whose wallet resolved to a user (except the creator
 *    themselves — they don't notify themselves). Deduplicated by userId.
 *  - externalEmails: signers whose wallet did NOT resolve to a user BUT whom the
 *    creator addressed by email. This is what lets you invite someone who has
 *    never used the app. Deduplicated by (normalized) email and excluded if
 *    already covered by an account.
 *
 * Pure function (no I/O) — the "don't duplicate the invite" rule isolated and
 * testable. Exported for unit testing: it's the critical decision of the invite
 * flow.
 */
export function partitionSignerNotifications(input: {
  requiredSigners: RequiredSigner[];
  /** Map publicKeyHex(normalized) → userId (from resolveUsersByWallets). */
  walletToUser: Map<string, string>;
  /** Request creator — doesn't self-notify. */
  createdByUserId: string;
}): SignerNotificationPlan {
  const { requiredSigners, walletToUser, createdByUserId } = input;

  // Accounts: unique values from the map, minus the creator.
  const accountUserIds = Array.from(
    new Set(
      Array.from(walletToUser.values()).filter(
        (uid) => uid !== createdByUserId,
      ),
    ),
  );

  // External: has an email, the wallet did NOT resolve to a user (otherwise
  // already covered by account), email deduplicated by normalized form.
  const seen = new Set<string>();
  const externalEmails: string[] = [];
  for (const s of requiredSigners) {
    if (!s.email) continue;
    if (walletToUser.has(norm(s.publicKeyHex))) continue;
    const key = s.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    externalEmails.push(s.email.trim());
  }

  return { accountUserIds, externalEmails };
}

/**
 * Creates a signature request. `transactionJson` is the base tx (built by
 * multisig.ts/prepareMultisigPayment, for example). Returns the created request.
 */
export async function createSignatureRequest(input: {
  createdByUserId: string;
  kind: "payment" | "setup";
  description?: string | null;
  transactionJson: string;
  requiredSigners: RequiredSigner[];
  threshold: number;
  chainName?: string;
  expiresAt?: Date | null;
}): Promise<SignatureRequestRow> {
  // Rejects a malformed/oversized tx before persisting.
  assertValidTransactionJson(input.transactionJson);

  // Opaque ID (full uuid v4, not truncated) — avoids enumeration.
  const id = randomUUID();
  const signers = input.requiredSigners.map((s) => ({
    publicKeyHex: norm(s.publicKeyHex),
    label: s.label,
  }));
  const threshold = Math.min(
    Math.max(input.threshold, 1),
    signers.length,
  );

  const rows = await db
    .insert(signatureRequests)
    .values({
      id,
      createdByUserId: input.createdByUserId,
      kind: input.kind,
      description: input.description ?? null,
      transactionJson: input.transactionJson,
      chainName: input.chainName ?? CHAIN_NAME,
      requiredSigners: signers,
      threshold,
      status: "pending",
      expiresAt:
        input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS),
    })
    .returning();

  return rows[0];
}

/** Looks up a request by id, or null. */
export async function getSignatureRequest(
  id: string,
): Promise<SignatureRequestRow | null> {
  const rows = await db
    .select()
    .from(signatureRequests)
    .where(eq(signatureRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Approvals collected for a request. */
export async function getApprovals(
  requestId: string,
): Promise<SignatureApprovalRow[]> {
  return db
    .select()
    .from(signatureApprovals)
    .where(eq(signatureApprovals.requestId, requestId));
}

/** request + approvals + derived state (signed/pending/ready). */
export async function getSignatureRequestState(
  id: string,
): Promise<SignatureRequestState | null> {
  const request = await getSignatureRequest(id);
  if (!request) return null;
  const approvals = await getApprovals(id);
  return deriveState(request, approvals);
}

/**
 * Persists ONE signature. Validates that:
 *  - the request exists and is in a collectable state (pending|ready);
 *  - it hasn't expired;
 *  - the signer is REQUIRED by the request (doesn't accept an outside signature);
 *  - the signature is CRYPTOGRAPHICALLY valid for the tx (blocks forgeries —
 *    without this, anyone could mark the request as signed by another signer).
 *
 * All within a single DB transaction with a status guard on the promotion
 * UPDATE (avoids a race: two simultaneous approvals don't corrupt the quorum
 * or downgrade an already-advanced state). Idempotent per (requestId, signer).
 *
 * Throws an Error with a stable message on violation (the route translates it to HTTP).
 */
export async function addApproval(input: {
  requestId: string;
  signerPublicKeyHex: string;
  signatureHex: string;
  signedByUserId?: string | null;
}): Promise<SignatureRequestState> {
  const request = await getSignatureRequest(input.requestId);
  if (!request) throw new Error("request_not_found");

  if (request.status !== "pending" && request.status !== "ready") {
    throw new Error("request_not_collectable");
  }
  if (request.expiresAt && request.expiresAt.getTime() < Date.now()) {
    await db
      .update(signatureRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(signatureRequests.id, request.id),
          inArray(signatureRequests.status, ["pending", "ready"]),
        ),
      );
    throw new Error("request_expired");
  }

  const signer = norm(input.signerPublicKeyHex);
  if (!requiredKeys(request).includes(signer)) {
    throw new Error("signer_not_required");
  }

  // Cryptographic verification: the signature must match the tx + the pubkey.
  const valid = verifyTxSignature({
    transactionJson: request.transactionJson,
    signerPublicKeyHex: signer,
    signatureHex: input.signatureHex,
  });
  if (!valid) throw new Error("invalid_signature");

  // Approval insert + recompute + promotion, atomic.
  await db.transaction(async (tx) => {
    await tx
      .insert(signatureApprovals)
      .values({
        id: randomUUID(),
        requestId: request.id,
        signerPublicKeyHex: signer,
        signatureHex: input.signatureHex,
        signedByUserId: input.signedByUserId ?? null,
      })
      .onConflictDoNothing({
        target: [
          signatureApprovals.requestId,
          signatureApprovals.signerPublicKeyHex,
        ],
      });

    const approvals = await tx
      .select()
      .from(signatureApprovals)
      .where(eq(signatureApprovals.requestId, request.id));
    const state = deriveState(request, approvals);

    // Promotes to "ready" only from "pending" (guard in the WHERE → CAS).
    if (state.ready) {
      await tx
        .update(signatureRequests)
        .set({
          status: "ready",
          version: sql`${signatureRequests.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(signatureRequests.id, request.id),
            eq(signatureRequests.status, "pending"),
          ),
        );
    }
  });

  // Fresh state post-transaction.
  const fresh = await getSignatureRequest(request.id);
  const approvals = await getApprovals(request.id);
  return deriveState(fresh ?? request, approvals);
}

/**
 * Rebuilds the final tx by accumulating ALL collected approvals onto the base
 * tx, via addMultisigApproval (same path as the in-memory multisig.ts), and
 * submits it on-chain. Only allowed when the request is "ready". Records the
 * hash and promotes to "broadcast". Returns the broadcast result + the updated request.
 *
 * The authorization restriction (creator only) is the route's responsibility
 * — this function assumes the check already passed.
 */
export async function broadcastSignatureRequest(requestId: string): Promise<{
  transactionHash: string;
  explorerUrl: string;
  request: SignatureRequestRow;
}> {
  const request = await getSignatureRequest(requestId);
  if (!request) throw new Error("request_not_found");
  if (request.status !== "ready") throw new Error("request_not_ready");

  const approvals = await getApprovals(requestId);
  const state = deriveState(request, approvals);
  if (!state.ready) throw new Error("quorum_not_met");

  // CAS: claims the ready → broadcast transition ATOMICALLY before submitting.
  // Only one process wins the UPDATE with the status='ready' guard; the
  // others get 0 rows and abort. Avoids double-broadcast on concurrent HTTP requests.
  const claimed = await db
    .update(signatureRequests)
    .set({
      status: "broadcast",
      version: sql`${signatureRequests.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(signatureRequests.id, requestId),
        eq(signatureRequests.status, "ready"),
      ),
    )
    .returning();
  if (claimed.length === 0) throw new Error("request_not_ready");

  // Builds the tx ONCE and attaches each approval on the SAME object,
  // submitting directly (no toJSON()/fromJSON() after signing). The
  // serialization round-trip after signing corrupts the tx for the node
  // (rejects with -32016 even though it validates locally) — same path as
  // the working broadcastUserSignedTransfer.
  let result: { transactionHash: string; explorerUrl: string };
  try {
    const tx = Transaction.fromJSON(JSON.parse(request.transactionJson));
    for (const approval of approvals) {
      const signer = PublicKey.fromHex(approval.signerPublicKeyHex);
      const sig = withAlgorithmTag(
        approval.signatureHex,
        approval.signerPublicKeyHex,
      );
      tx.setSignature(sig, signer);
    }
    const res = await getRpc().putTransaction(tx);
    const hash = res.transactionHash.toHex();
    result = {
      transactionHash: hash,
      explorerUrl: `https://testnet.cspr.live/deploy/${hash}`,
    };
  } catch (e) {
    // Failed on-chain: reverts the request to "ready" for a retry.
    await db
      .update(signatureRequests)
      .set({ status: "ready", updatedAt: new Date() })
      .where(eq(signatureRequests.id, requestId));
    throw e;
  }

  const updated = await db
    .update(signatureRequests)
    .set({
      transactionHash: result.transactionHash,
      updatedAt: new Date(),
    })
    .where(eq(signatureRequests.id, requestId))
    .returning();

  return { ...result, request: updated[0] };
}

/**
 * Checks on-chain whether a "broadcast" request has been confirmed; if so,
 * promotes it to "confirmed". Called by the reconciliation cron. Best-effort:
 * RPC errors don't throw (leaves it for the next cycle).
 */
export async function reconcileBroadcastStatus(
  requestId: string,
): Promise<SignatureRequestStatus | null> {
  const request = await getSignatureRequest(requestId);
  if (!request || request.status !== "broadcast" || !request.transactionHash) {
    return request?.status ?? null;
  }
  try {
    const res = await getRpc().getTransactionByTransactionHash(
      request.transactionHash,
    );
    const executed = res?.transaction != null;
    if (executed) {
      await db
        .update(signatureRequests)
        .set({
          status: "confirmed",
          version: sql`${signatureRequests.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(signatureRequests.id, requestId),
            eq(signatureRequests.status, "broadcast"),
          ),
        );
      return "confirmed";
    }
  } catch {
    // RPC unavailable — retries on the next cycle.
  }
  return "broadcast";
}

/** Cancels a request (only makes sense while pending|ready). */
export async function cancelSignatureRequest(
  requestId: string,
): Promise<void> {
  await db
    .update(signatureRequests)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(signatureRequests.id, requestId),
        inArray(signatureRequests.status, ["pending", "ready"]),
      ),
    );
}

/** Requests created by a user, most recent first. */
export async function listRequestsByCreator(
  userId: string,
  opts: {
    status?: SignatureRequestStatus[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<SignatureRequestRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const filters = [eq(signatureRequests.createdByUserId, userId)];
  if (opts.status && opts.status.length > 0) {
    filters.push(inArray(signatureRequests.status, opts.status));
  }
  return db
    .select()
    .from(signatureRequests)
    .where(and(...filters))
    .orderBy(desc(signatureRequests.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Requests "awaiting my signature": collectable (pending|ready), not expired,
 * where one of the user's wallets is a required signer and hasn't signed yet.
 *
 * ONE query with LEFT JOIN (no N+1): fetches open requests + their approvals
 * in one shot, groups in memory.
 */
export async function listPendingForSigner(
  signerPublicKeysHex: string[],
): Promise<SignatureRequestState[]> {
  const keys = signerPublicKeysHex.map(norm);
  if (keys.length === 0) return [];

  const now = new Date();
  const rows = await db
    .select({
      request: signatureRequests,
      approval: signatureApprovals,
    })
    .from(signatureRequests)
    .leftJoin(
      signatureApprovals,
      eq(signatureApprovals.requestId, signatureRequests.id),
    )
    .where(
      and(
        inArray(signatureRequests.status, ["pending", "ready"]),
        or(
          isNull(signatureRequests.expiresAt),
          gt(signatureRequests.expiresAt, now),
        ),
      ),
    )
    .orderBy(desc(signatureRequests.createdAt));

  // Groups approvals by request.
  const byId = new Map<
    string,
    { request: SignatureRequestRow; approvals: SignatureApprovalRow[] }
  >();
  for (const row of rows) {
    let entry = byId.get(row.request.id);
    if (!entry) {
      entry = { request: row.request, approvals: [] };
      byId.set(row.request.id, entry);
    }
    if (row.approval) entry.approvals.push(row.approval);
  }

  const result: SignatureRequestState[] = [];
  for (const { request, approvals } of byId.values()) {
    const required = requiredKeys(request);
    const isSigner = keys.some((k) => required.includes(k));
    if (!isSigner) continue;
    const signedByMe = approvals.some((a) =>
      keys.includes(norm(a.signerPublicKeyHex)),
    );
    if (signedByMe) continue;
    result.push(deriveState(request, approvals));
  }
  return result;
}

/**
 * Proactive expiration sweep: marks as "expired" every pending|ready request
 * whose expiresAt has already passed. Called by the cron. Returns the number affected.
 */
export async function sweepExpiredRequests(): Promise<number> {
  const res = await db
    .update(signatureRequests)
    .set({
      status: "expired",
      version: sql`${signatureRequests.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(signatureRequests.status, ["pending", "ready"]),
        lt(signatureRequests.expiresAt, new Date()),
      ),
    )
    .returning({ id: signatureRequests.id });
  return res.length;
}

/** IDs of requests in "broadcast" (for the cron to reconcile against the network). */
export async function listBroadcastRequestIds(): Promise<string[]> {
  const rows = await db
    .select({ id: signatureRequests.id })
    .from(signatureRequests)
    .where(eq(signatureRequests.status, "broadcast"));
  return rows.map((r) => r.id);
}
