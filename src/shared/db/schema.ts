import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// better-auth tables (user/session/account/verification). Generated via the
// CLI (auth-schema.ts) and re-exported here so they're picked up by
// migrations + the client.
export * from "./auth-schema";

/**
 * dedup_key → Recall.ai bot_id mapping.
 *
 * Recall does NOT dedupe bots created via Create Bot (only in the Calendar
 * Integration). This table is the app's source of truth: it guarantees 1 bot
 * per meeting (scope). Typical dedup_key:
 * `${meeting_start_time}-${meeting_url}` (one bot per meeting).
 */
export const recallBots = pgTable(
  "recall_bots",
  {
    /** Stable dedup key defined by the app. PK. */
    dedupKey: text("dedup_key").primaryKey(),
    /** Bot ID returned by Recall. */
    botId: text("bot_id").notNull(),
    /** Meeting URL (Recall may clear it days after the join). */
    meetingUrl: text("meeting_url").notNull(),
    /** join_at ISO 8601, null for ad-hoc bots. */
    joinAt: timestamp("join_at", { withTimezone: true }),
    /** Arbitrary app metadata (resourceId, threadId, etc.). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("recall_bots_bot_id_idx").on(table.botId)],
);

export type RecallBotRow = typeof recallBots.$inferSelect;
export type NewRecallBotRow = typeof recallBots.$inferInsert;

/**
 * User → Recall.ai calendar mapping (Calendar V2, multi-user).
 *
 * Each app user connects their own calendar (Google/Outlook). Recall creates
 * a calendar per connection and returns an `id`. This table links that `id`
 * to the user.
 *
 * Dedup is by (platform, platformEmail): Recall does NOT dedupe calendars on
 * creation. Before creating one, we look it up by email+platform and
 * reconnect (PATCH) if it already exists disconnected, instead of creating a
 * duplicate.
 */
export const userCalendars = pgTable(
  "user_calendars",
  {
    /** Calendar ID returned by Recall (api/v2/calendars). PK. */
    recallCalendarId: text("recall_calendar_id").primaryKey(),
    /** User ID in our system (calendar owner). */
    userId: text("user_id").notNull(),
    /** Platform: "google_calendar" | "microsoft_outlook". */
    platform: text("platform").notNull(),
    /** Authorized account email (dedup key together with platform). */
    platformEmail: text("platform_email"),
    /** Last known calendar status (connecting/connected/disconnected). */
    status: text("status"),
    /** Arbitrary app metadata. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("user_calendars_user_id_idx").on(table.userId),
    index("user_calendars_email_platform_idx").on(
      table.platformEmail,
      table.platform,
    ),
  ],
);

export type UserCalendarRow = typeof userCalendars.$inferSelect;
export type NewUserCalendarRow = typeof userCalendars.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// Multisig SaaS — distributed signature collection
//
// Flow: the owner creates a signature_request (the base tx + list of signers
// + quorum). Each signer opens the /sign/:id link, signs with their own
// wallet, and the signature is persisted in signature_approvals (1 per
// signer). When the number of approvals reaches the threshold, the request
// becomes "ready" and can be broadcast on-chain. notifications notifies
// in-app each signer who has an account.
//
// Enforcement note: the Casper network only honors N signatures if the payer
// account is NATIVELY multisig (associated keys + weights, via
// multisig-setup.ts). Without that, the approvals exist on-chain
// (demonstrable) but only the owner's counts toward the network threshold.
// This layer collects the signatures; the real enforcement depends on the
// account's native setup — see src/lib/casper/multisig-setup.ts.
// ───────────────────────────────────────────────────────────────────────────

/** Lifecycle of a request (enforced by the database via enum). */
export const signatureRequestStatusEnum = pgEnum("signature_request_status", [
  "pending",
  "ready",
  "broadcast",
  "confirmed",
  "expired",
  "cancelled",
]);

/** Request kind. */
export const signatureRequestKindEnum = pgEnum("signature_request_kind", [
  "payment",
  "setup",
]);

export type SignatureRequestStatus =
  (typeof signatureRequestStatusEnum.enumValues)[number];
export type SignatureRequestKind =
  (typeof signatureRequestKindEnum.enumValues)[number];

/**
 * Casper wallet(s) linked to an app user.
 *
 * Allows resolving wallet → user (to notify signers who have an account) and
 * building the "awaiting my signature" dashboard (matched by publicKeyHex).
 * Idempotent by (userId, publicKeyHex): linking the same wallet twice
 * doesn't duplicate.
 */
export const userWallets = pgTable(
  "user_wallets",
  {
    id: text("id").primaryKey(),
    /** Wallet owner (FK better-auth user). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Casper public key (hex, normalized lowercase). */
    publicKeyHex: text("public_key_hex").notNull(),
    /** Optional user-defined label ("cold wallet", etc.). */
    label: text("label"),
    /**
     * When key possession was PROVEN (verified nonce signature). null = link
     * without proof (shouldn't happen in the new flow; kept nullable for
     * compat). Only verified wallets count as a signer.
     */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("user_wallets_user_id_idx").on(table.userId),
    index("user_wallets_public_key_idx").on(table.publicKeyHex),
    uniqueIndex("user_wallets_user_key_uq").on(
      table.userId,
      table.publicKeyHex,
    ),
  ],
);

export type UserWalletRow = typeof userWallets.$inferSelect;
export type NewUserWalletRow = typeof userWallets.$inferInsert;

/** A signer required by a signature_request. */
export interface RequiredSigner {
  publicKeyHex: string;
  label?: string;
  /**
   * Optional e-mail supplied by the creator to invite an EXTERNAL signer — one
   * who has no linked wallet, so wallet→user resolution can't find them. When
   * present, the request-creation route e-mails the /sign link directly to this
   * address. Signers with a linked account are reached via user resolution and
   * don't need this. Stored in the jsonb column, so no migration is required.
   */
  email?: string;
}

/**
 * A multisig request: the base tx + who needs to sign + the quorum + state.
 *
 * `transactionJson` is the serialized tx (same format as the in-memory
 * multisig.ts), persisted here instead of traveling through the LLM/session.
 * Approvals accumulate in signature_approvals; on broadcast, we record
 * transactionHash.
 */
export const signatureRequests = pgTable(
  "signature_requests",
  {
    /** Short ID/uuid — also the /sign/:id link slug. */
    id: text("id").primaryKey(),
    /** Who created it (FK user). Only the creator can broadcast/cancel. */
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Kind (enum). */
    kind: signatureRequestKindEnum("kind").notNull(),
    /** Natural-language description ("Pay 100 CSPR to supplier X"). */
    description: text("description"),
    /** The serialized base tx (without completed approvals). */
    transactionJson: text("transaction_json").notNull(),
    chainName: text("chain_name").notNull(),
    /** Required signers: [{ publicKeyHex, label? }]. */
    requiredSigners: jsonb("required_signers")
      .$type<RequiredSigner[]>()
      .notNull(),
    /** Quorum: number of signatures required to broadcast. */
    threshold: integer("threshold").notNull(),
    /** Lifecycle (enum). */
    status: signatureRequestStatusEnum("status").notNull().default("pending"),
    /**
     * Optimistic-lock / state mutation counter. Increments on every
     * transition. Enables generic CAS on concurrent updates.
     */
    version: integer("version").notNull().default(0),
    /** On-chain hash after broadcast. */
    transactionHash: text("transaction_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("signature_requests_creator_idx").on(table.createdByUserId),
    // Partial index: only ACTIVE requests (the bulk of read queries).
    index("signature_requests_active_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.status} in ('pending','ready')`),
    // Quorum must be >= 1 (enforced by the database).
    check("signature_requests_threshold_check", sql`${table.threshold} >= 1`),
  ],
);

export type SignatureRequestRow = typeof signatureRequests.$inferSelect;
export type NewSignatureRequestRow = typeof signatureRequests.$inferInsert;

/**
 * A signature collected for a signature_request (1 per signer).
 *
 * unique (requestId, signerPublicKeyHex) guarantees idempotency: re-signing
 * doesn't duplicate. signedByUserId is nullable (a signer can sign via link
 * without an account, identified only by their wallet).
 */
export const signatureApprovals = pgTable(
  "signature_approvals",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => signatureRequests.id, { onDelete: "cascade" }),
    /** Public key that signed (hex, normalized). */
    signerPublicKeyHex: text("signer_public_key_hex").notNull(),
    /** Raw hex signature returned by the wallet. */
    signatureHex: text("signature_hex").notNull(),
    /** User who signed, if authenticated (nullable — signature via link). */
    signedByUserId: text("signed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("signature_approvals_request_idx").on(table.requestId),
    uniqueIndex("signature_approvals_request_signer_uq").on(
      table.requestId,
      table.signerPublicKeyHex,
    ),
  ],
);

export type SignatureApprovalRow = typeof signatureApprovals.$inferSelect;
export type NewSignatureApprovalRow = typeof signatureApprovals.$inferInsert;

/**
 * In-app notification. Created when a request is opened (notifies each
 * signer who has an account) and on state changes. Marked read via readAt.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    /** Recipient (FK user). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Type: "signature_requested" | "request_ready" | "broadcast" | ... */
    type: text("type").notNull(),
    /** Related request, if any. */
    requestId: text("request_id").references(() => signatureRequests.id, {
      onDelete: "cascade",
    }),
    message: text("message").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("notifications_user_idx").on(table.userId),
    // Partial index: only UNREAD ones (what the bell queries).
    index("notifications_user_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

/**
 * Wallet proof-of-possession nonce (SIWE-style).
 *
 * To link a wallet, the user signs this nonce with the key; the server
 * verifies the signature (PublicKey.verifySignature) before recording the
 * link. The nonce is single-use and expires. Prevents linking someone else's
 * pubkey.
 */
export const walletLinkNonces = pgTable(
  "wallet_link_nonces",
  {
    /** The nonce (random string). PK. */
    nonce: text("nonce").primaryKey(),
    /** User who requested the nonce (FK). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Consumed (after successful verification). */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("wallet_link_nonces_user_idx").on(table.userId)],
);

export type WalletLinkNonceRow = typeof walletLinkNonces.$inferSelect;

// ───────────────────────────────────────────────────────────────────────────
// Persisted meeting minutes (meeting_records)
//
// Recall clears the transcript/artifacts days after the meeting, and
// generating the minutes costs an LLM call. Persisting here makes the
// minutes the app's source of truth:
//  - the bot webhook enqueues the enrichment (durable, with retry via Inngest);
//  - the enrichment writes the structured summary + transcript text here;
//  - the UI/tools read from here (cache), without re-fetching from Recall or
//    re-paying for the LLM;
//  - the reconciliation cron sweeps rows stuck in "pending"/"processing".
// ───────────────────────────────────────────────────────────────────────────

/** Lifecycle of a minutes' enrichment (enforced by the database via enum). */
export const meetingRecordStatusEnum = pgEnum("meeting_record_status", [
  "pending", // queued, transcript not yet processed
  "processing", // enrichment running
  "done", // minutes generated and persisted
  "failed", // failed after retries
]);

export const meetingRecords = pgTable(
  "meeting_records",
  {
    /** Recall botId — 1 minutes record per bot. PK. */
    botId: text("bot_id").primaryKey(),
    /** Meeting owner (for scoping/notification). */
    userId: text("user_id"),
    /** Meeting URL (denormalized for display). */
    meetingUrl: text("meeting_url"),
    /** Enrichment state. */
    status: meetingRecordStatusEnum("status").notNull().default("pending"),
    /** Number of enrichment attempts (for diagnostics/backoff). */
    attempts: integer("attempts").notNull().default(0),
    /** Last error message, if failed. */
    error: text("error"),
    /** "Speaker: line" transcript text (cache; Recall expires it). */
    transcript: text("transcript"),
    /** Executive summary generated by the LLM. */
    summary: text("summary"),
    /** Prose overview (paragraph). */
    overview: text("overview"),
    /** Decisions: string[]. */
    decisions: jsonb("decisions").$type<string[]>(),
    /** Action items: { task, owner|null }[]. */
    actionItems: jsonb("action_items").$type<
      Array<{ task: string; owner: string | null }>
    >(),
    /** Main topics: string[]. */
    topics: jsonb("topics").$type<string[]>(),
    /** Thematic sections: { title, bullets[], startSeconds|null }[]. */
    sections: jsonb("sections").$type<
      Array<{ title: string; bullets: string[]; startSeconds: number | null }>
    >(),
    /** Key moments: { label, kind, atSeconds|null }[]. */
    moments: jsonb("moments").$type<
      Array<{
        label: string;
        kind: "topic" | "action" | "question" | "objection";
        atSeconds: number | null;
      }>
    >(),
    /** % speaking time per participant: { name, share }[] (share 0..1). */
    talkShares: jsonb("talk_shares").$type<
      Array<{ name: string; share: number }>
    >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("meeting_records_user_idx").on(table.userId),
    index("meeting_records_status_idx").on(table.status),
  ],
);

export type MeetingRecordRow = typeof meetingRecords.$inferSelect;
export type NewMeetingRecordRow = typeof meetingRecords.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// Web3 billing — prepaid ledger + on-chain anchor
//
// Model: the user DEPOSITS CSPR into the app's account (tx signed by their
// wallet, verified on-chain via transactionHash). Each recorded meeting
// generates a usage debit (minutes × price). The balance is the sum of
// credits (deposits) minus debits (usage) — kept off-chain (fast, no gas per
// minute).
//
// Settle: a cron aggregates not-yet-anchored usage per user and NOTARIZES the
// batch on-chain (batch hash as transfer_id, same engine as meeting-notary) —
// immutable, auditable proof of how much was charged, without moving funds
// per minute.
//
// Monetary values in MOTES (bigint as string via numeric) to avoid losing
// precision — 1 CSPR = 1e9 motes. Never use float for money.
// ───────────────────────────────────────────────────────────────────────────

/** Credits: user CSPR deposits, each backed by an on-chain tx. */
export const billingDeposits = pgTable(
  "billing_deposits",
  {
    /** On-chain deposit transaction hash. PK (idempotency: 1 credit/tx). */
    txHash: text("tx_hash").primaryKey(),
    /** Credited user. */
    userId: text("user_id").notNull(),
    /** Credited amount, in motes (1 CSPR = 1e9). */
    amountMotes: text("amount_motes").notNull(),
    /** Deposit's source public key (for auditing). */
    fromPublicKey: text("from_public_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("billing_deposits_user_idx").on(table.userId)],
);

export type BillingDepositRow = typeof billingDeposits.$inferSelect;
export type NewBillingDepositRow = typeof billingDeposits.$inferInsert;

/** Debits: usage measured per meeting. 1 row per bot (idempotent metering). */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    /** botId of the charged meeting. PK: 1 debit per meeting. */
    botId: text("bot_id").primaryKey(),
    /** Charged user. */
    userId: text("user_id").notNull(),
    /** Recorded minutes (rounded up), basis for the cost. */
    minutes: integer("minutes").notNull(),
    /** Cost in motes = minutes × price/min. */
    costMotes: text("cost_motes").notNull(),
    /** Settle tx that anchored this usage on-chain (null = not yet settled). */
    settledTxHash: text("settled_tx_hash"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("usage_ledger_user_idx").on(table.userId),
    // Partial index: only debits NOT YET anchored (what settle sweeps).
    index("usage_ledger_unsettled_idx")
      .on(table.userId)
      .where(sql`${table.settledTxHash} is null`),
  ],
);

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type NewUsageLedgerRow = typeof usageLedger.$inferInsert;
