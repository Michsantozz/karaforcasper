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

// Tabelas do better-auth (user/session/account/verification). Geradas via CLI
// (auth-schema.ts) e re-exportadas aqui para entrarem nas migrations + no client.
export * from "./auth-schema";

/**
 * Mapeamento dedup_key → bot_id do Recall.ai.
 *
 * O Recall NÃO deduplica bots criados via Create Bot (só na Calendar Integration).
 * Esta tabela é a fonte de verdade do app: garante 1 bot por (escopo de) meeting.
 * dedup_key típico: `${meeting_start_time}-${meeting_url}` (um bot por meeting).
 */
export const recallBots = pgTable(
  "recall_bots",
  {
    /** Chave de deduplicação estável definida pelo app. PK. */
    dedupKey: text("dedup_key").primaryKey(),
    /** ID do bot retornado pelo Recall. */
    botId: text("bot_id").notNull(),
    /** URL da meeting (pode ser limpa pelo Recall dias após o join). */
    meetingUrl: text("meeting_url").notNull(),
    /** join_at ISO 8601, null para bots ad-hoc. */
    joinAt: timestamp("join_at", { withTimezone: true }),
    /** Metadata arbitrária do app (resourceId, threadId, etc.). */
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
 * Mapeamento user → calendar do Recall.ai (Calendar V2, multi-usuário).
 *
 * Cada usuário do app conecta a própria agenda (Google/Outlook). O Recall cria
 * um calendar por conexão e devolve um `id`. Esta tabela liga esse `id` ao user.
 *
 * Dedup é por (platform, platformEmail): o Recall NÃO deduplica calendars na
 * criação. Antes de criar, consultamos por e-mail+plataforma e reconectamos
 * (PATCH) se já existir desconectado, em vez de criar duplicata.
 */
export const userCalendars = pgTable(
  "user_calendars",
  {
    /** ID do calendar retornado pelo Recall (api/v2/calendars). PK. */
    recallCalendarId: text("recall_calendar_id").primaryKey(),
    /** ID do usuário no nosso sistema (dono da agenda). */
    userId: text("user_id").notNull(),
    /** Plataforma: "google_calendar" | "microsoft_outlook". */
    platform: text("platform").notNull(),
    /** E-mail da conta autorizada (chave de dedup junto com platform). */
    platformEmail: text("platform_email"),
    /** Último status conhecido do calendar (connecting/connected/disconnected). */
    status: text("status"),
    /** Metadata arbitrária do app. */
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
// Multisig SaaS — coleta distribuída de assinaturas
//
// Fluxo: o dono cria uma signature_request (a tx base + lista de signatários +
// quórum). Cada signatário abre o link /sign/:id, assina pela própria carteira,
// e a assinatura é persistida em signature_approvals (1 por signatário). Quando
// o nº de approvals atinge o threshold, a request fica "ready" e pode ser
// broadcast on-chain. notifications avisa in-app cada signatário que tem conta.
//
// Nota de enforcement: a rede Casper só honra N assinaturas se a conta pagadora
// for multisig NATIVA (associated keys + weights, via multisig-setup.ts). Sem
// isso, as approvals existem on-chain (demonstrável) mas só a do dono conta para
// o threshold da rede. Esta camada coleta as assinaturas; o enforcement real
// depende do setup nativo da conta — ver src/lib/casper/multisig-setup.ts.
// ───────────────────────────────────────────────────────────────────────────

/** Ciclo de vida de uma solicitação (enforced pelo banco via enum). */
export const signatureRequestStatusEnum = pgEnum("signature_request_status", [
  "pending",
  "ready",
  "broadcast",
  "confirmed",
  "expired",
  "cancelled",
]);

/** Tipo de solicitação. */
export const signatureRequestKindEnum = pgEnum("signature_request_kind", [
  "payment",
  "setup",
]);

export type SignatureRequestStatus =
  (typeof signatureRequestStatusEnum.enumValues)[number];
export type SignatureRequestKind =
  (typeof signatureRequestKindEnum.enumValues)[number];

/**
 * Carteira(s) Casper vinculada(s) a um usuário do app.
 *
 * Permite resolver carteira → user (para notificar signatários que têm conta) e
 * montar o dashboard "aguardando minha assinatura" (match por publicKeyHex).
 * Idempotente por (userId, publicKeyHex): vincular a mesma carteira duas vezes
 * não duplica.
 */
export const userWallets = pgTable(
  "user_wallets",
  {
    id: text("id").primaryKey(),
    /** Dono da carteira (FK better-auth user). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Public key Casper (hex, normalizada lowercase). */
    publicKeyHex: text("public_key_hex").notNull(),
    /** Rótulo opcional definido pelo usuário ("cold wallet", etc.). */
    label: text("label"),
    /**
     * Quando a posse da chave foi PROVADA (assinatura de nonce verificada).
     * null = vínculo sem prova (não deve acontecer no fluxo novo; mantido
     * nullable para compat). Só carteiras verificadas contam como signatário.
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

/** Um signatário exigido por uma signature_request. */
export interface RequiredSigner {
  publicKeyHex: string;
  label?: string;
}

/**
 * Uma solicitação multisig: a tx base + quem precisa assinar + o quórum + estado.
 *
 * `transactionJson` é a tx serializada (mesmo formato do multisig.ts em memória),
 * persistida aqui em vez de trafegar pelo LLM/sessão. As approvals acumulam em
 * signature_approvals; ao broadcast, gravamos transactionHash.
 */
export const signatureRequests = pgTable(
  "signature_requests",
  {
    /** ID curto/uuid — também o slug do link /sign/:id. */
    id: text("id").primaryKey(),
    /** Quem criou (FK user). Só o criador pode broadcast/cancelar. */
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Tipo (enum). */
    kind: signatureRequestKindEnum("kind").notNull(),
    /** Descrição em linguagem natural ("Pagar 100 CSPR ao fornecedor X"). */
    description: text("description"),
    /** A tx base serializada (sem approvals completas). */
    transactionJson: text("transaction_json").notNull(),
    chainName: text("chain_name").notNull(),
    /** Signatários exigidos: [{ publicKeyHex, label? }]. */
    requiredSigners: jsonb("required_signers")
      .$type<RequiredSigner[]>()
      .notNull(),
    /** Quórum: nº de assinaturas necessárias para broadcast. */
    threshold: integer("threshold").notNull(),
    /** Ciclo de vida (enum). */
    status: signatureRequestStatusEnum("status").notNull().default("pending"),
    /**
     * Optimistic-lock / contador de mutações de estado. Incrementa a cada
     * transição. Permite CAS genérico em updates concorrentes.
     */
    version: integer("version").notNull().default(0),
    /** Hash on-chain após broadcast. */
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
    // Índice parcial: só as requests ATIVAS (o grosso das queries de leitura).
    index("signature_requests_active_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.status} in ('pending','ready')`),
    // Quórum tem que ser >= 1 (enforced pelo banco).
    check("signature_requests_threshold_check", sql`${table.threshold} >= 1`),
  ],
);

export type SignatureRequestRow = typeof signatureRequests.$inferSelect;
export type NewSignatureRequestRow = typeof signatureRequests.$inferInsert;

/**
 * Uma assinatura coletada para uma signature_request (1 por signatário).
 *
 * unique (requestId, signerPublicKeyHex) garante idempotência: re-assinar não
 * duplica. signedByUserId é nullable (o signatário pode assinar via link sem ter
 * conta, identificado só pela carteira).
 */
export const signatureApprovals = pgTable(
  "signature_approvals",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => signatureRequests.id, { onDelete: "cascade" }),
    /** Public key que assinou (hex, normalizada). */
    signerPublicKeyHex: text("signer_public_key_hex").notNull(),
    /** Assinatura crua hex retornada pela carteira. */
    signatureHex: text("signature_hex").notNull(),
    /** User que assinou, se autenticado (nullable — assinatura via link). */
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
 * Notificação in-app. Criada ao abrir uma request (avisa cada signatário que tem
 * conta) e ao mudar de estado. Marcada lida via readAt.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    /** Destinatário (FK user). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Tipo: "signature_requested" | "request_ready" | "broadcast" | ... */
    type: text("type").notNull(),
    /** Request relacionada, se houver. */
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
    // Índice parcial: só as NÃO lidas (o que o sininho consulta).
    index("notifications_user_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

/**
 * Nonce de prova de posse de carteira (SIWE-style).
 *
 * Para vincular uma carteira, o usuário assina este nonce com a chave; o server
 * verifica a assinatura (PublicKey.verifySignature) antes de gravar o vínculo.
 * Nonce é de uso único e expira. Evita vincular pubkey alheia.
 */
export const walletLinkNonces = pgTable(
  "wallet_link_nonces",
  {
    /** O nonce (string aleatória). PK. */
    nonce: text("nonce").primaryKey(),
    /** Usuário que pediu o nonce (FK). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Consumido (após verificação bem-sucedida). */
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
// Atas de reunião persistidas (meeting_records)
//
// O Recall limpa transcript/artefatos dias após a reunião, e gerar a ata custa
// uma chamada de LLM. Persistir aqui torna a ata a fonte de verdade do app:
//  - o webhook de bot enfileira o enrichment (durável, com retry via Inngest);
//  - o enrichment grava aqui o resumo estruturado + o texto da transcrição;
//  - a UI/tools leem daqui (cache), sem re-buscar do Recall nem re-pagar LLM;
//  - o cron de reconciliação varre linhas presas em "pending"/"processing".
// ───────────────────────────────────────────────────────────────────────────

/** Ciclo de vida do enrichment de uma ata (enforced pelo banco via enum). */
export const meetingRecordStatusEnum = pgEnum("meeting_record_status", [
  "pending", // enfileirado, transcrição ainda não processada
  "processing", // enrichment em execução
  "done", // ata gerada e persistida
  "failed", // falhou após os retries
]);

export const meetingRecords = pgTable(
  "meeting_records",
  {
    /** botId do Recall — 1 ata por bot. PK. */
    botId: text("bot_id").primaryKey(),
    /** Dono da reunião (para escopo/notificação). */
    userId: text("user_id"),
    /** URL da meeting (denormalizada para exibição). */
    meetingUrl: text("meeting_url"),
    /** Estado do enrichment. */
    status: meetingRecordStatusEnum("status").notNull().default("pending"),
    /** Nº de tentativas de enrichment (para diagnóstico/backoff). */
    attempts: integer("attempts").notNull().default(0),
    /** Última mensagem de erro, se failed. */
    error: text("error"),
    /** Texto "Participante: fala" da transcrição (cache; Recall expira). */
    transcript: text("transcript"),
    /** Resumo executivo gerado pelo LLM. */
    summary: text("summary"),
    /** Overview em prosa (parágrafo). */
    overview: text("overview"),
    /** Decisões: string[]. */
    decisions: jsonb("decisions").$type<string[]>(),
    /** Action items: { task, owner|null }[]. */
    actionItems: jsonb("action_items").$type<
      Array<{ task: string; owner: string | null }>
    >(),
    /** Tópicos principais: string[]. */
    topics: jsonb("topics").$type<string[]>(),
    /** Seções temáticas: { title, bullets[], startSeconds|null }[]. */
    sections: jsonb("sections").$type<
      Array<{ title: string; bullets: string[]; startSeconds: number | null }>
    >(),
    /** Momentos-chave: { label, kind, atSeconds|null }[]. */
    moments: jsonb("moments").$type<
      Array<{
        label: string;
        kind: "topic" | "action" | "question" | "objection";
        atSeconds: number | null;
      }>
    >(),
    /** % de tempo de fala por participante: { name, share }[] (share 0..1). */
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
// Billing web3 — prepaid ledger + on-chain anchor
//
// Modelo: o usuário DEPOSITA CSPR na conta do app (tx assinada pela carteira
// dele, verificada on-chain pelo transactionHash). Cada reunião gravada gera um
// débito de uso (minutos × preço). O saldo é a soma de créditos (depósitos)
// menos débitos (uso) — mantido off-chain (rápido, sem gas por minuto).
//
// Settle: um cron agrega o uso ainda não ancorado por usuário e NOTARIZA o batch
// on-chain (hash do batch como transfer_id, mesmo motor de meeting-notary) —
// prova imutável e auditável de quanto foi cobrado, sem mover fundos por minuto.
//
// Valores monetários em MOTES (bigint como string via numeric) para não perder
// precisão — 1 CSPR = 1e9 motes. Nunca usar float para dinheiro.
// ───────────────────────────────────────────────────────────────────────────

/** Créditos: depósitos de CSPR do usuário, cada um lastreado por uma tx on-chain. */
export const billingDeposits = pgTable(
  "billing_deposits",
  {
    /** Hash da transação de depósito on-chain. PK (idempotência: 1 crédito/tx). */
    txHash: text("tx_hash").primaryKey(),
    /** Usuário creditado. */
    userId: text("user_id").notNull(),
    /** Valor creditado, em motes (1 CSPR = 1e9). */
    amountMotes: text("amount_motes").notNull(),
    /** Public key de origem do depósito (para auditoria). */
    fromPublicKey: text("from_public_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("billing_deposits_user_idx").on(table.userId)],
);

export type BillingDepositRow = typeof billingDeposits.$inferSelect;
export type NewBillingDepositRow = typeof billingDeposits.$inferInsert;

/** Débitos: uso medido por reunião. 1 linha por bot (idempotente no metering). */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    /** botId da reunião cobrada. PK: 1 débito por reunião. */
    botId: text("bot_id").primaryKey(),
    /** Usuário cobrado. */
    userId: text("user_id").notNull(),
    /** Minutos gravados (arredondados p/ cima), base do custo. */
    minutes: integer("minutes").notNull(),
    /** Custo em motes = minutes × preço/min. */
    costMotes: text("cost_motes").notNull(),
    /** Tx de settle que ancorou este uso on-chain (null = ainda não settled). */
    settledTxHash: text("settled_tx_hash"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("usage_ledger_user_idx").on(table.userId),
    // Índice parcial: só os débitos ainda NÃO ancorados (o que o settle varre).
    index("usage_ledger_unsettled_idx")
      .on(table.userId)
      .where(sql`${table.settledTxHash} is null`),
  ],
);

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type NewUsageLedgerRow = typeof usageLedger.$inferInsert;
