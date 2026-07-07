import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { transferCsprTool } from "@/mastra/tools/casper.tool";
import { prepareMultisigPaymentRequestTool } from "@/mastra/tools/signature-request.tool";

// Os inputSchemas Zod são a fronteira de confiança LLM→ação: barram argumentos
// malformados ANTES de qualquer caminho que mova fundos. Testamos o schema em
// si (sem executar a tool).

const schemaOf = (tool: unknown): ZodType =>
  (tool as { inputSchema: ZodType }).inputSchema;

const PUB = "01" + "a".repeat(64);

describe("transfer_cspr — inputSchema (fronteira LLM→dinheiro)", () => {
  const schema = schemaOf(transferCsprTool);

  it("aceita amount positivo", () => {
    const r = schema.safeParse({ toPublicKeyHex: PUB, amountCspr: 2.5 });
    expect(r.success).toBe(true);
  });

  it("rejeita amount zero", () => {
    expect(
      schema.safeParse({ toPublicKeyHex: PUB, amountCspr: 0 }).success,
    ).toBe(false);
  });

  it("rejeita amount negativo", () => {
    expect(
      schema.safeParse({ toPublicKeyHex: PUB, amountCspr: -1 }).success,
    ).toBe(false);
  });

  it("rejeita amount não-numérico", () => {
    expect(
      schema.safeParse({ toPublicKeyHex: PUB, amountCspr: "muito" }).success,
    ).toBe(false);
  });

  it("rejeita amount ausente", () => {
    expect(schema.safeParse({ toPublicKeyHex: PUB }).success).toBe(false);
  });
});

describe("prepare_multisig_payment_request — piso monetário de 2.5 CSPR", () => {
  const schema = schemaOf(prepareMultisigPaymentRequestTool);
  const base = {
    fromPublicKeyHex: PUB,
    toPublicKeyHex: "01" + "b".repeat(64),
    signers: [{ publicKeyHex: PUB }],
  };

  it("aceita exatamente 2.5 CSPR (boundary inclusivo)", () => {
    expect(schema.safeParse({ ...base, amountCspr: 2.5 }).success).toBe(true);
  });

  it("rejeita logo abaixo de 2.5 (2.49999)", () => {
    expect(schema.safeParse({ ...base, amountCspr: 2.49999 }).success).toBe(
      false,
    );
  });

  it("rejeita 0 e negativo", () => {
    expect(schema.safeParse({ ...base, amountCspr: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, amountCspr: -5 }).success).toBe(false);
  });

  it("threshold, quando dado, deve ser inteiro positivo", () => {
    expect(
      schema.safeParse({ ...base, amountCspr: 3, threshold: 0 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, amountCspr: 3, threshold: 1.5 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, amountCspr: 3, threshold: 2 }).success,
    ).toBe(true);
  });

  it("threshold é opcional (ausente é válido)", () => {
    expect(schema.safeParse({ ...base, amountCspr: 3 }).success).toBe(true);
  });
});
