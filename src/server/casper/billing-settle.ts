import "server-only";
import { randomUUID } from "node:crypto";
import { NativeTransferBuilder, PublicKey } from "casper-js-sdk";
import { CHAIN_NAME, getRpc, getAgentKey, getAgentPublicKeyHex } from "./client";
import { hashToTransferId } from "./meeting-notary";
import {
  hashUsageBatch,
  claimUnsettledUsage,
  releaseUsageClaim,
  reapStaleClaims,
  listUsersWithUnsettledUsage,
  markUsageSettled,
} from "./billing";
import { withSystemScope } from "@/shared/db/rls";

// Anchor = transfer mínimo para o próprio agente, carregando o hash do batch no
// transfer id. Mesma mecânica de meeting-notary: prova imutável on-chain de que
// aquele conjunto de cobranças existiu neste estado, sem mover fundos por minuto.
const ANCHOR_AMOUNT_MOTES = "2500000000"; // 2.5 CSPR (mínimo de transfer)
const ANCHOR_PAYMENT_MOTES = 100_000_000; // ~0.1 CSPR de gas
// Claim mais velho que isto é considerado órfão (tick morreu antes de ancorar) e
// é liberado no início do ciclo. Folgado vs. a duração de uma submissão on-chain.
const STALE_CLAIM_MS = 15 * 60 * 1000; // 15 min

export interface SettleUserResult {
  userId: string;
  botIds: string[];
  batchHash: string;
  transactionHash: string;
  explorerUrl: string;
}

/**
 * Ancora on-chain o uso não-settled de UM usuário: agrega os débitos, calcula o
 * hash determinístico do batch, submete um transfer com o id derivado do hash e
 * marca as linhas como settled com o txHash. Idempotente: se não há uso, no-op.
 */
export async function settleUserUsage(
  userId: string,
): Promise<SettleUserResult | null> {
  // Reivindica atomicamente o uso pendente sob system scope (transação curta): o
  // UPDATE condicional marca as linhas com um claimToken ÚNICO POR TICK e devolve
  // só as capturadas. Dois ticks de cron sobrepostos usam tokens distintos, então
  // cada débito é capturado por exatamente um tick — nunca ancoram o mesmo batch
  // duas vezes (gas dobrado). A tx on-chain (lenta, rede) roda FORA da transação
  // Postgres para não prender conexão do pool.
  const claimToken = randomUUID();
  const rows = await withSystemScope(() =>
    claimUnsettledUsage(userId, claimToken),
  );
  if (rows.length === 0) return null;

  const batchHash = hashUsageBatch(
    rows.map((r) => ({ botId: r.botId, costMotes: r.costMotes })),
  );
  const transferId = hashToTransferId(batchHash);

  const key = await getAgentKey();
  const notary = await getAgentPublicKeyHex();

  const tx = new NativeTransferBuilder()
    .from(key.publicKey)
    .target(PublicKey.fromHex(notary)) // para si mesmo: só ancora
    .amount(ANCHOR_AMOUNT_MOTES)
    .id(transferId)
    .chainName(CHAIN_NAME)
    .payment(ANCHOR_PAYMENT_MOTES)
    .build();

  tx.sign(key);
  let transactionHash: string;
  try {
    const res = await getRpc().putTransaction(tx);
    transactionHash = res.transactionHash.toHex();
  } catch (err) {
    // A tx on-chain falhou → libera o claim para o próximo tick retentar.
    await withSystemScope(() =>
      releaseUsageClaim(
        rows.map((r) => r.botId),
        claimToken,
      ),
    );
    throw err;
  }

  // Finaliza o claim com o txHash real. Casa pelo claimToken, não por IS NULL.
  await withSystemScope(() =>
    markUsageSettled(
      rows.map((r) => r.botId),
      transactionHash,
      claimToken,
    ),
  );

  return {
    userId,
    botIds: rows.map((r) => r.botId),
    batchHash,
    transactionHash,
    explorerUrl: `https://testnet.cspr.live/deploy/${transactionHash}`,
  };
}

/**
 * Settle de todos os usuários com uso pendente. Chamado pelo cron. Retorna
 * quantos usuários foram ancorados e quantas reuniões no total.
 */
export async function settleAllUsage(): Promise<{
  users: number;
  meetings: number;
}> {
  // Libera claims órfãos (ticks anteriores que crasharam entre claim e anchor)
  // antes de varrer — senão ficariam presos em "claiming:*" e nunca settlariam.
  await withSystemScope(() => reapStaleClaims(STALE_CLAIM_MS));

  const userIds = await withSystemScope(() => listUsersWithUnsettledUsage());
  let users = 0;
  let meetings = 0;
  for (const userId of userIds) {
    const res = await settleUserUsage(userId).catch(() => null);
    if (res) {
      users++;
      meetings += res.botIds.length;
    }
  }
  return { users, meetings };
}
