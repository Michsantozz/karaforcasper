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
 * Camada de coleta distribuída de assinaturas (multisig SaaS).
 *
 * Persiste uma solicitação (tx base + signatários + quórum) e acumula as
 * assinaturas como linhas em signature_approvals — uma por signatário, com
 * idempotência garantida pelo unique (requestId, signerPublicKeyHex) no schema.
 *
 * Diferença do multisig.ts (em memória): aqui o estado é durável e cada approval
 * é um registro. A tx serializada na request é a BASE (sem approvals); só no
 * broadcast a gente reconstrói a tx acumulando cada signatura via
 * addMultisigApproval — reusando exatamente o caminho já validado.
 *
 * Enforcement: ver nota no schema — a rede só honra N assinaturas se a conta
 * pagadora for multisig nativa (multisig-setup.ts). Esta camada coleta; o
 * threshold aqui é o quórum do PRODUTO, não necessariamente o da rede.
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const MAX_TX_JSON_BYTES = 64_000;
// A Casper testnet (Condor 2.0) recusa transfer nativo abaixo deste mínimo com
// "insufficient transfer amount" (-32016). Validamos na criação para não
// persistir uma solicitação que nunca vai poder ser broadcastada.
const MIN_TRANSFER_CSPR = 2.5;

function norm(hex: string): string {
  return hex.trim().toLowerCase();
}

/**
 * Valida que `transactionJson` é uma tx Casper bem-formada (parseable) e dentro
 * do limite de tamanho. Lança em caso de violação. Usado ao criar a request para
 * não persistir lixo.
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
  // Recusa cedo transfers abaixo do mínimo da rede (senão a request fica presa
  // em "ready" e estoura no broadcast). Best-effort: só valida se decodou o valor.
  const { amountCspr } = decodeTransfer(transactionJson);
  if (amountCspr != null && Number(amountCspr) < MIN_TRANSFER_CSPR) {
    throw new Error("transfer_below_minimum");
  }
}

export interface DecodedTransfer {
  /** Valor real em CSPR (decodado da tx, não da descrição). */
  amountCspr: string | null;
  /** Destino real (account-hash ou pubkey) decodado da tx. */
  target: string | null;
}

/**
 * Decoda o valor e o destino REAIS de uma tx de transferência a partir do JSON
 * serializado — para o signatário ver o que está assinando, independente da
 * `description` (que o criador pode falsear). Best-effort: campos variam por
 * versão do SDK; retorna null no que não conseguir extrair.
 */
export function decodeTransfer(transactionJson: string): DecodedTransfer {
  try {
    const tx = Transaction.fromJSON(JSON.parse(transactionJson));
    // Args tipados do transfer nativo (Transaction 2.0): a V1 carrega
    // payload.fields.args (Args), de onde lemos os CLValues 'amount'/'target'
    // já desserializados — não os bytes crus do JSON.
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
 * Verifica CRIPTOGRAFICAMENTE que `signatureHex` é uma assinatura válida de
 * `signerPublicKeyHex` sobre a tx base. Reconstrói a tx, anexa a assinatura e
 * chama tx.validate() — o SDK verifica cada approval contra o hash da tx
 * (ErrInvalidApprovalSignature em assinatura forjada). Retorna true/false.
 *
 * Isto barra assinaturas forjadas ANTES do broadcast (sem gastar gas na rede).
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
    tx.validate(); // lança se alguma approval não bate com o hash
    return true;
  } catch {
    return false;
  }
}

export interface SignatureRequestState {
  request: SignatureRequestRow;
  approvals: SignatureApprovalRow[];
  /** Public keys (normalizadas) que já assinaram. */
  signed: string[];
  /** Public keys exigidas que ainda faltam. */
  pending: string[];
  /** Atingiu o quórum (>= threshold assinaturas válidas)? */
  ready: boolean;
}

/** Public keys exigidas (normalizadas) a partir do jsonb da request. */
function requiredKeys(request: SignatureRequestRow): string[] {
  return request.requiredSigners.map((s) => norm(s.publicKeyHex));
}

/**
 * Deriva o estado (signed/pending/ready) das approvals persistidas.
 * Exportado para teste unitário — é a decisão de quórum antes do broadcast.
 */
export function deriveState(
  request: SignatureRequestRow,
  approvals: SignatureApprovalRow[],
): SignatureRequestState {
  const required = requiredKeys(request);
  // Só conta approvals de signatários EXIGIDOS (defesa contra ruído).
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

/**
 * Cria uma solicitação de assinatura. `transactionJson` é a tx base (montada por
 * multisig.ts/prepareMultisigPayment, por exemplo). Devolve a request criada.
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
  // Rejeita tx malformada/grande antes de persistir.
  assertValidTransactionJson(input.transactionJson);

  // ID opaco (uuid v4 completo, não fatiado) — evita enumeração.
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

/** Busca uma request pelo id, ou null. */
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

/** Approvals coletadas de uma request. */
export async function getApprovals(
  requestId: string,
): Promise<SignatureApprovalRow[]> {
  return db
    .select()
    .from(signatureApprovals)
    .where(eq(signatureApprovals.requestId, requestId));
}

/** request + approvals + estado derivado (signed/pending/ready). */
export async function getSignatureRequestState(
  id: string,
): Promise<SignatureRequestState | null> {
  const request = await getSignatureRequest(id);
  if (!request) return null;
  const approvals = await getApprovals(id);
  return deriveState(request, approvals);
}

/**
 * Persiste UMA assinatura. Valida que:
 *  - a request existe e está em estado coletável (pending|ready);
 *  - não expirou;
 *  - o signatário é EXIGIDO pela request (não aceita assinatura de fora);
 *  - a assinatura é CRIPTOGRAFICAMENTE válida para a tx (barra forjadas — sem
 *    isso, qualquer um marcaria a request como assinada por outro signatário).
 *
 * Tudo dentro de uma transação do banco com guard de status no UPDATE de
 * promoção (evita race: dois approvals simultâneos não corrompem o quórum nem
 * rebaixam um estado já avançado). Idempotente por (requestId, signer).
 *
 * Lança Error com mensagem estável em caso de violação (a rota traduz em HTTP).
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

  // Verificação criptográfica: a assinatura tem que bater com a tx + a pubkey.
  const valid = verifyTxSignature({
    transactionJson: request.transactionJson,
    signerPublicKeyHex: signer,
    signatureHex: input.signatureHex,
  });
  if (!valid) throw new Error("invalid_signature");

  // Insert da approval + recálculo + promoção, atômico.
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

    // Promove a "ready" só a partir de "pending" (guard no WHERE → CAS).
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

  // Estado fresco pós-transação.
  const fresh = await getSignatureRequest(request.id);
  const approvals = await getApprovals(request.id);
  return deriveState(fresh ?? request, approvals);
}

/**
 * Reconstrói a tx final acumulando TODAS as approvals coletadas sobre a tx base,
 * via addMultisigApproval (mesmo caminho do multisig.ts em memória), e submete
 * on-chain. Só permitido quando a request está "ready". Grava o hash e promove a
 * "broadcast". Devolve o resultado do broadcast + a request atualizada.
 *
 * Restrição de autorização (só o criador) é responsabilidade da rota — esta
 * função assume que a checagem já passou.
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

  // CAS: reivindica a transição ready → broadcast ATOMICAMENTE antes de submeter.
  // Só um processo vence o UPDATE com guard status='ready'; os demais recebem 0
  // linhas e abortam. Evita double-broadcast em requests HTTP concorrentes.
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

  // Monta a tx UMA vez e anexa cada approval no MESMO objeto, submetendo direto
  // (sem toJSON()/fromJSON() depois de assinar). O round-trip de serialização
  // pós-assinatura corrompe a tx para o nó (rejeita com -32016 mesmo validando
  // localmente) — é o mesmo caminho do broadcastUserSignedTransfer que funciona.
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
    // Falhou no on-chain: devolve a request a "ready" para nova tentativa.
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
 * Verifica on-chain se uma request "broadcast" foi confirmada; se sim, promove a
 * "confirmed". Chamado pelo cron de reconciliação. Best-effort: erros de RPC não
 * lançam (deixa para o próximo ciclo).
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
    // RPC indisponível — tenta de novo no próximo ciclo.
  }
  return "broadcast";
}

/** Cancela uma request (só faz sentido enquanto pending|ready). */
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

/** Requests criadas por um usuário, mais recentes primeiro. */
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
 * Requests "aguardando minha assinatura": coletável (pending|ready), não
 * expirada, em que uma das carteiras do usuário é signatária exigida e ainda não
 * assinou.
 *
 * UMA query com LEFT JOIN (sem N+1): traz requests abertas + suas approvals de
 * uma vez, agrupa em memória.
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

  // Agrupa approvals por request.
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
 * Sweep proativo de expiração: marca como "expired" toda request pending|ready
 * cujo expiresAt já passou. Chamado pelo cron. Retorna o nº de afetadas.
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

/** IDs de requests em "broadcast" (para o cron reconciliar contra a rede). */
export async function listBroadcastRequestIds(): Promise<string[]> {
  const rows = await db
    .select({ id: signatureRequests.id })
    .from(signatureRequests)
    .where(eq(signatureRequests.status, "broadcast"));
  return rows.map((r) => r.id);
}
