import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * billing.ts — o ledger de dinheiro web3 (prepaid + anchor on-chain). Cobrimos:
 *
 *  Aritmética PURA (sem DB), onde erro = cobrança errada:
 *   - pricePerMinuteMotes / costForMinutes: CSPR→motes exato, sem float; ceil de
 *     minutos; piso em 0;
 *   - hashUsageBatch: determinístico e INVARIANTE À ORDEM (mesmo conjunto de
 *     débitos → mesmo hash → mesmo transferId do anchor).
 *
 *  Concorrência do settle (o claim/reaper que blindam o double-anchor):
 *   - claimUnsettledUsage: UPDATE condicional carimba "claiming:<token>";
 *   - markUsageSettled: finaliza CASANDO o token do claim (não IS NULL);
 *   - releaseUsageClaim / reapStaleClaims: voltam a coluna para NULL.
 *
 *  Saldo e crédito:
 *   - balanceMotes = Σ depósitos − Σ uso (bigint, sem perda);
 *   - creditDeposit: onConflictDoNothing → retorna true só se inseriu.
 *
 * scopedDb (a conexão RLS) é mockada por um fake query-builder que captura os
 * .set()/.values() e devolve linhas controláveis — isolamos a lógica, não o
 * driver Postgres. Os helpers do drizzle viram tags inspecionáveis.
 */

// Estado controlável: o que cada await na cadeia resolve, e o que foi capturado.
// selectQueue permite dar retornos DIFERENTES a selects sucessivos (ex.: balance
// lê depósitos e depois uso). Cada where() consome o próximo da fila; se a fila
// esvazia, repete o último (ou [] se nunca setado).
const dbState = {
  selectQueue: [] as unknown[][],
  returningRows: [] as unknown[], // resolve de ...returning()
  captured: {
    values: undefined as unknown,
    set: undefined as unknown,
    where: undefined as unknown,
    onConflictTarget: undefined as unknown,
  },
};

function nextSelect(): unknown[] {
  if (dbState.selectQueue.length === 0) return [];
  return dbState.selectQueue.length === 1
    ? dbState.selectQueue[0]
    : (dbState.selectQueue.shift() as unknown[]);
}

// Fake query builder: cada método devolve o próprio builder (thenable) para
// encadear; o await final resolve conforme a operação (select vs returning).
function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.from = chain;
  builder.insert = chain;
  builder.update = chain;
  builder.values = (v: unknown) => {
    dbState.captured.values = v;
    return builder;
  };
  builder.set = (v: unknown) => {
    dbState.captured.set = v;
    return builder;
  };
  builder.where = (w: unknown) => {
    dbState.captured.where = w;
    // where encerra um select: torna o builder um thenable que resolve as rows.
    return {
      ...builder,
      then: (res: (r: unknown) => void) => res(nextSelect()),
      returning: () => Promise.resolve(dbState.returningRows),
    };
  };
  builder.onConflictDoNothing = (opts: unknown) => {
    dbState.captured.onConflictTarget = opts;
    return {
      returning: () => Promise.resolve(dbState.returningRows),
      then: (res: (r: unknown) => void) => res(undefined),
    };
  };
  builder.returning = () => Promise.resolve(dbState.returningRows);
  return builder;
}

vi.mock("@/shared/db/rls", () => ({
  scopedDb: () => makeBuilder(),
}));

// Colunas viram objetos-tag; os helpers do drizzle viram tags inspecionáveis
// para asserir a forma do WHERE sem depender da implementação real.
vi.mock("@/shared/db/schema", () => ({
  billingDeposits: {
    amountMotes: "billingDeposits.amountMotes",
    userId: "billingDeposits.userId",
    txHash: "billingDeposits.txHash",
  },
  usageLedger: {
    costMotes: "usageLedger.costMotes",
    userId: "usageLedger.userId",
    botId: "usageLedger.botId",
    settledTxHash: "usageLedger.settledTxHash",
    settledAt: "usageLedger.settledAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
  like: (col: unknown, pat: unknown) => ({ op: "like", col, pat }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
}));

beforeEach(() => {
  dbState.selectQueue = [];
  dbState.returningRows = [];
  dbState.captured = {
    values: undefined,
    set: undefined,
    where: undefined,
    onConflictTarget: undefined,
  };
  delete process.env.BILLING_PRICE_PER_MINUTE_CSPR;
});
afterEach(() => vi.resetModules());

async function load() {
  return import("@/server/casper/billing");
}

describe("preço e custo — CSPR→motes exato, sem float", () => {
  it("preço default = 0.5 CSPR/min = 500_000_000 motes", async () => {
    const { pricePerMinuteMotes } = await load();
    expect(pricePerMinuteMotes()).toBe(500_000_000n);
  });

  it("respeita BILLING_PRICE_PER_MINUTE_CSPR do env", async () => {
    process.env.BILLING_PRICE_PER_MINUTE_CSPR = "2";
    const { pricePerMinuteMotes } = await load();
    expect(pricePerMinuteMotes()).toBe(2_000_000_000n);
  });

  it("costForMinutes arredonda minutos para cima (ceil)", async () => {
    const { costForMinutes } = await load();
    // 3.2 min → 4 min × 0.5 CSPR = 2_000_000_000 motes
    expect(costForMinutes(3.2)).toBe(2_000_000_000n);
  });

  it("costForMinutes piso em 0 para minutos negativos", async () => {
    const { costForMinutes } = await load();
    expect(costForMinutes(-5)).toBe(0n);
  });
});

describe("hashUsageBatch — determinístico e invariante à ordem", () => {
  it("mesmo conjunto em ordens diferentes → mesmo hash", async () => {
    const { hashUsageBatch } = await load();
    const a = hashUsageBatch([
      { botId: "b1", costMotes: "100" },
      { botId: "b2", costMotes: "200" },
    ]);
    const b = hashUsageBatch([
      { botId: "b2", costMotes: "200" },
      { botId: "b1", costMotes: "100" },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("conjuntos diferentes → hashes diferentes", async () => {
    const { hashUsageBatch } = await load();
    const a = hashUsageBatch([{ botId: "b1", costMotes: "100" }]);
    const b = hashUsageBatch([{ botId: "b1", costMotes: "101" }]);
    expect(a).not.toBe(b);
  });
});

describe("balanceMotes — Σ depósitos − Σ uso (bigint)", () => {
  it("calcula saldo sem perda de precisão", async () => {
    const { balanceMotes } = await load();
    // balanceMotes lê totalDeposits e totalUsage (Promise.all → 2 selects). A fila
    // dá retornos distintos a cada where(): depósitos 3 CSPR, uso 1 CSPR → saldo 2.
    dbState.selectQueue = [
      [{ amount: "3000000000" }],
      [{ cost: "1000000000" }],
    ];
    const bal = await balanceMotes("u1");
    expect(bal).toBe(2_000_000_000n);
  });
});

describe("creditDeposit — idempotente por txHash", () => {
  it("retorna true quando insere (returning tem linha)", async () => {
    dbState.returningRows = [{ txHash: "tx1" }];
    const { creditDeposit } = await load();
    const ok = await creditDeposit({
      txHash: "tx1",
      userId: "u1",
      amountMotes: 5n,
    });
    expect(ok).toBe(true);
    expect((dbState.captured.values as { amountMotes: string }).amountMotes).toBe(
      "5",
    );
  });

  it("retorna false quando conflito (returning vazio = já creditado)", async () => {
    dbState.returningRows = [];
    const { creditDeposit } = await load();
    const ok = await creditDeposit({
      txHash: "tx1",
      userId: "u1",
      amountMotes: 5n,
    });
    expect(ok).toBe(false);
  });
});

describe("claim/reaper — blindagem do double-anchor", () => {
  it("claimUnsettledUsage carimba 'claiming:<token>' e devolve as capturadas", async () => {
    dbState.returningRows = [{ botId: "b1" }, { botId: "b2" }];
    const { claimUnsettledUsage, SETTLE_CLAIM_PREFIX } = await load();
    const rows = await claimUnsettledUsage("u1", "tok-123");
    expect(rows).toHaveLength(2);
    // O .set() gravou o token com o prefixo de claim.
    expect((dbState.captured.set as { settledTxHash: string }).settledTxHash).toBe(
      SETTLE_CLAIM_PREFIX + "tok-123",
    );
    // WHERE filtra userId + settled_tx_hash IS NULL (só linhas livres).
    const where = dbState.captured.where as { args: Array<{ op: string }> };
    expect(where.args.some((a) => a.op === "isNull")).toBe(true);
  });

  it("markUsageSettled casa pelo CLAIM TOKEN, não por IS NULL", async () => {
    const { markUsageSettled, SETTLE_CLAIM_PREFIX } = await load();
    await markUsageSettled(["b1", "b2"], "0xrealhash", "tok-123");
    const where = dbState.captured.where as {
      args: Array<{ op: string; val?: string }>;
    };
    // Um dos predicados é eq(settledTxHash, "claiming:tok-123") — garante que só
    // quem detém este claim finaliza (dois ticks não colidem).
    expect(
      where.args.some(
        (a) => a.op === "eq" && a.val === SETTLE_CLAIM_PREFIX + "tok-123",
      ),
    ).toBe(true);
    // E grava o txHash real + settledAt.
    expect((dbState.captured.set as { settledTxHash: string }).settledTxHash).toBe(
      "0xrealhash",
    );
  });

  it("markUsageSettled com lista vazia é no-op (não toca DB)", async () => {
    const { markUsageSettled } = await load();
    await markUsageSettled([], "0xhash", "tok");
    expect(dbState.captured.set).toBeUndefined();
  });

  it("releaseUsageClaim volta settled_tx_hash para NULL", async () => {
    const { releaseUsageClaim } = await load();
    await releaseUsageClaim(["b1"], "tok-123");
    expect((dbState.captured.set as { settledTxHash: null }).settledTxHash).toBe(
      null,
    );
  });

  it("reapStaleClaims libera claims mais velhos que o cutoff", async () => {
    dbState.returningRows = [{ botId: "b1" }, { botId: "b2" }, { botId: "b3" }];
    const { reapStaleClaims } = await load();
    const n = await reapStaleClaims(15 * 60 * 1000);
    expect(n).toBe(3);
    // Reset da coluna + o WHERE usa like("claiming:%") e lt(settledAt, cutoff).
    expect((dbState.captured.set as { settledTxHash: null }).settledTxHash).toBe(
      null,
    );
    const where = dbState.captured.where as { args: Array<{ op: string }> };
    expect(where.args.some((a) => a.op === "like")).toBe(true);
    expect(where.args.some((a) => a.op === "lt")).toBe(true);
  });
});
