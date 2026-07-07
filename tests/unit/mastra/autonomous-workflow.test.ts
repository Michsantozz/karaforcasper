import { describe, expect, it, vi } from "vitest";
import {
  decideAction,
  type DecideAndActConfig,
} from "@/mastra/workflows/autonomous.workflow";

// decideAction é o coração do loop autônomo — decide se MOVE FUNDOS, de hora em
// hora, SEM humano no loop. É o código mais crítico do repo. Estes testes fixam:
// gate de saldo no boundary, gate de target-ausente, e o contrato fail-closed
// (erro do transfer NUNCA vira acted:true).

const cfg = (over: Partial<DecideAndActConfig> = {}): DecideAndActConfig => ({
  heartbeatTarget: "01" + "d".repeat(64),
  minBalanceCspr: 5,
  heartbeatCspr: 1,
  ...over,
});

const okTransfer = vi.fn(async () => ({ transactionHash: "deadbeef" }));

describe("decideAction — gate de target ausente", () => {
  it("sem heartbeatTarget: não age e NÃO chama transfer", async () => {
    const transfer = vi.fn(okTransfer);
    const r = await decideAction("100", cfg({ heartbeatTarget: "" }), transfer);
    expect(r.acted).toBe(false);
    expect(r.decision).toContain("CASPER_HEARTBEAT_TARGET");
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe("decideAction — gate de saldo (boundary)", () => {
  it("saldo abaixo do mínimo: não age", async () => {
    const transfer = vi.fn(okTransfer);
    const r = await decideAction("3", cfg(), transfer);
    expect(r.acted).toBe(false);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("saldo EXATAMENTE no mínimo: não age (<= não <)", async () => {
    const transfer = vi.fn(okTransfer);
    const r = await decideAction("5", cfg({ minBalanceCspr: 5 }), transfer);
    expect(r.acted).toBe(false);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("saldo logo acima do mínimo: AGE", async () => {
    const transfer = vi.fn(okTransfer);
    const r = await decideAction("5.0001", cfg({ minBalanceCspr: 5 }), transfer);
    expect(r.acted).toBe(true);
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("saldo não-numérico (NaN): não age (fail-safe)", async () => {
    const transfer = vi.fn(okTransfer);
    const r = await decideAction("não-é-número", cfg(), transfer);
    expect(r.acted).toBe(false);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe("decideAction — ação e contrato fail-closed", () => {
  it("sucesso: acted true, decision reflete a tx e o bool concorda", async () => {
    const transfer = vi.fn(async () => ({ transactionHash: "abc123" }));
    const r = await decideAction("100", cfg(), transfer);
    expect(r.acted).toBe(true);
    expect(r.decision).toContain("AÇÃO: transfer");
    expect(r.decision).toContain("abc123");
    expect(transfer).toHaveBeenCalledWith({
      toPublicKeyHex: cfg().heartbeatTarget,
      amountCspr: 1,
    });
  });

  it("erro do transfer (política de gasto) → acted:false, NUNCA sucesso", async () => {
    const transfer = vi.fn(async () => {
      throw new Error("TransferPolicyError: acima do teto");
    });
    const r = await decideAction("100", cfg(), transfer);
    expect(r.acted).toBe(false);
    expect(r.decision).toContain("BLOQUEADO");
    expect(r.decision).toContain("acima do teto");
  });

  it("erro não-Error também é capturado como acted:false", async () => {
    const transfer = vi.fn(async () => {
      throw "string solta";
    });
    const r = await decideAction("100", cfg(), transfer);
    expect(r.acted).toBe(false);
  });

  it("decision e acted nunca divergem entre si", async () => {
    // acted:true só quando a string diz AÇÃO; acted:false só com AGUARDANDO/BLOQUEADO.
    const acted = await decideAction("100", cfg(), okTransfer);
    expect(acted.acted && acted.decision.startsWith("AÇÃO")).toBe(true);

    const blocked = await decideAction(
      "100",
      cfg(),
      vi.fn(async () => {
        throw new Error("x");
      }),
    );
    expect(!blocked.acted && blocked.decision.startsWith("BLOQUEADO")).toBe(true);
  });
});
