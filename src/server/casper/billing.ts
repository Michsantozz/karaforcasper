import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, like, lt } from "drizzle-orm";
import { scopedDb } from "@/shared/db/rls";
import {
  billingDeposits,
  usageLedger,
  type UsageLedgerRow,
} from "@/shared/db/schema";

/**
 * Billing web3 — prepaid ledger + on-chain anchor (camada capability).
 *
 * Saldo = Σ depósitos (créditos, lastreados por tx on-chain) − Σ uso (débitos).
 * Tudo em MOTES (bigint) para não perder precisão. O settle não move fundos por
 * minuto: ele NOTARIZA o batch de uso on-chain (ver settleUsage no worker).
 */

export const MOTES_PER_CSPR = 1_000_000_000n;

/** Preço por minuto de gravação, em motes. Default 0.5 CSPR/min. */
export function pricePerMinuteMotes(): bigint {
  const env = process.env.BILLING_PRICE_PER_MINUTE_CSPR;
  const cspr = env ? Number(env) : 0.5;
  return BigInt(Math.round(cspr * Number(MOTES_PER_CSPR)));
}

/** Custo de uma reunião (motes) a partir dos minutos. */
export function costForMinutes(minutes: number): bigint {
  return BigInt(Math.max(0, Math.ceil(minutes))) * pricePerMinuteMotes();
}

/** Soma total de depósitos do usuário (motes). */
async function totalDeposits(userId: string): Promise<bigint> {
  const rows = await scopedDb()
    .select({ amount: billingDeposits.amountMotes })
    .from(billingDeposits)
    .where(eq(billingDeposits.userId, userId));
  return rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

/** Soma total de uso do usuário (motes), settled ou não. */
async function totalUsage(userId: string): Promise<bigint> {
  const rows = await scopedDb()
    .select({ cost: usageLedger.costMotes })
    .from(usageLedger)
    .where(eq(usageLedger.userId, userId));
  return rows.reduce((acc, r) => acc + BigInt(r.cost), 0n);
}

/** Saldo disponível do usuário em motes (pode ser negativo se estourou). */
export async function balanceMotes(userId: string): Promise<bigint> {
  const [deposits, usage] = await Promise.all([
    totalDeposits(userId),
    totalUsage(userId),
  ]);
  return deposits - usage;
}

/** Saldo em CSPR (string, para exibição). */
export async function balanceCspr(userId: string): Promise<string> {
  const motes = await balanceMotes(userId);
  return (Number(motes) / Number(MOTES_PER_CSPR)).toString();
}

/**
 * Credita um depósito. Idempotente por txHash (PK). Chamado após verificar a tx
 * on-chain (que os fundos chegaram à conta do app). Retorna false se já creditado.
 */
export async function creditDeposit(input: {
  txHash: string;
  userId: string;
  amountMotes: bigint;
  fromPublicKey?: string | null;
}): Promise<boolean> {
  const res = await scopedDb()
    .insert(billingDeposits)
    .values({
      txHash: input.txHash,
      userId: input.userId,
      amountMotes: input.amountMotes.toString(),
      fromPublicKey: input.fromPublicKey ?? null,
    })
    .onConflictDoNothing({ target: billingDeposits.txHash })
    .returning({ txHash: billingDeposits.txHash });
  return res.length > 0;
}

/**
 * Registra o débito de uso de uma reunião. Idempotente por botId (PK): medir a
 * mesma reunião duas vezes não dobra a cobrança.
 */
export async function recordUsage(input: {
  botId: string;
  userId: string;
  minutes: number;
}): Promise<void> {
  const cost = costForMinutes(input.minutes);
  await scopedDb()
    .insert(usageLedger)
    .values({
      botId: input.botId,
      userId: input.userId,
      minutes: Math.max(0, Math.ceil(input.minutes)),
      costMotes: cost.toString(),
    })
    .onConflictDoNothing({ target: usageLedger.botId });
}

/**
 * Gate de saldo: true se o usuário tem crédito para (pelo menos) mais uma
 * reunião do tamanho estimado. Usado antes de agendar/criar um bot.
 */
export async function hasBalanceForMinutes(
  userId: string,
  estimatedMinutes: number,
): Promise<boolean> {
  const [balance, needed] = await Promise.all([
    balanceMotes(userId),
    Promise.resolve(costForMinutes(estimatedMinutes)),
  ]);
  return balance >= needed;
}

/** Débitos ainda não ancorados on-chain, de um usuário. */
export async function listUnsettledUsage(
  userId: string,
): Promise<UsageLedgerRow[]> {
  return scopedDb()
    .select()
    .from(usageLedger)
    .where(
      and(eq(usageLedger.userId, userId), isNull(usageLedger.settledTxHash)),
    );
}

/**
 * Prefixo do claim otimista de settle. Marca uma linha como "em processo de
 * ancoragem por este tick" antes de submeter a tx on-chain (lenta). Como o
 * settle roda a rede FORA da transação Postgres, dois ticks de cron sobrepostos
 * leriam as mesmas linhas não-settled e ancorariam o MESMO batch duas vezes
 * (gas dobrado). O claim atômico resolve: o UPDATE condicional
 * (WHERE settled_tx_hash IS NULL) só captura as linhas que ainda ninguém pegou,
 * então cada débito é ancorado por exatamente um tick. É um lock por-linha
 * durável (sobrevive a crash: um claim órfão é limpo por releaseUsageClaim no
 * retry) sem advisory lock de sessão (que vazaria no pool).
 */
export const SETTLE_CLAIM_PREFIX = "claiming:";

/**
 * Reivindica atomicamente os débitos não-settled de um usuário para este tick.
 * Retorna só as linhas efetivamente capturadas (as que estavam livres). Um tick
 * concorrente que rode ao mesmo tempo captura um subconjunto disjunto (ou vazio).
 * O claimToken deve ser único por tick (ex.: derivado do batchHash).
 */
export async function claimUnsettledUsage(
  userId: string,
  claimToken: string,
): Promise<UsageLedgerRow[]> {
  // Grava settledAt = agora no claim: serve de timestamp do lock para o reaper
  // (reapStaleClaims) liberar claims órfãos deixados por um tick que crashou
  // entre o claim e o mark. Só é sobrescrito com o instante real no markUsageSettled.
  return scopedDb()
    .update(usageLedger)
    .set({ settledTxHash: SETTLE_CLAIM_PREFIX + claimToken, settledAt: new Date() })
    .where(
      and(eq(usageLedger.userId, userId), isNull(usageLedger.settledTxHash)),
    )
    .returning();
}

/**
 * Libera claims órfãos: linhas presas em "claiming:*" cujo claim é mais velho
 * que staleMs — sinal de que o tick que as reivindicou morreu antes de ancorar.
 * Chamado no início de cada ciclo de settle. Volta a coluna para NULL para que
 * o próximo tick as capture de novo. staleMs deve ser > que a duração máxima
 * esperada de uma submissão on-chain, para não roubar um claim ainda em voo.
 */
export async function reapStaleClaims(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const res = await scopedDb()
    .update(usageLedger)
    .set({ settledTxHash: null, settledAt: null })
    .where(
      and(
        like(usageLedger.settledTxHash, SETTLE_CLAIM_PREFIX + "%"),
        lt(usageLedger.settledAt, cutoff),
      ),
    )
    .returning({ botId: usageLedger.botId });
  return res.length;
}

/** Libera um claim (volta a coluna para NULL) — usado quando a tx on-chain falha. */
export async function releaseUsageClaim(
  botIds: string[],
  claimToken: string,
): Promise<void> {
  if (botIds.length === 0) return;
  await scopedDb()
    .update(usageLedger)
    .set({ settledTxHash: null })
    .where(
      and(
        eq(usageLedger.settledTxHash, SETTLE_CLAIM_PREFIX + claimToken),
        inArray(usageLedger.botId, botIds),
      ),
    );
}

/** Usuários com uso não ancorado (para o cron de settle iterar). */
export async function listUsersWithUnsettledUsage(): Promise<string[]> {
  const rows = await scopedDb()
    .selectDistinct({ userId: usageLedger.userId })
    .from(usageLedger)
    .where(isNull(usageLedger.settledTxHash));
  return rows.map((r) => r.userId);
}

/**
 * Finaliza os débitos reivindicados por este tick, gravando o txHash real do
 * anchor. Casa pelo claimToken (não por IS NULL): as linhas já saíram de NULL no
 * claim, então só quem detém este claim as finaliza — dois ticks não colidem.
 */
export async function markUsageSettled(
  botIds: string[],
  settledTxHash: string,
  claimToken: string,
): Promise<void> {
  if (botIds.length === 0) return;
  await scopedDb()
    .update(usageLedger)
    .set({ settledTxHash, settledAt: new Date() })
    .where(
      and(
        eq(usageLedger.settledTxHash, SETTLE_CLAIM_PREFIX + claimToken),
        inArray(usageLedger.botId, botIds),
      ),
    );
}

/**
 * Hash determinístico de um batch de uso — id do anchor on-chain. Mesma lista de
 * (botId, cost) → mesmo hash, independente da ordem.
 */
export function hashUsageBatch(
  rows: Array<{ botId: string; costMotes: string }>,
): string {
  const canonical = JSON.stringify(
    rows
      .map((r) => ({ botId: r.botId, cost: r.costMotes }))
      .sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0)),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
