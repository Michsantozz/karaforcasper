import { describe, expect, it } from "vitest";
import {
  toMotes,
  approvalSigners,
  buildState,
  prepareMultisigPayment,
} from "@/server/casper/multisig";

const A = "01" + "a".repeat(64);
const B = "01" + "b".repeat(64);
const C = "01" + "c".repeat(64);

describe("toMotes — conversão CSPR→motes (money math)", () => {
  it("converte inteiros (1 CSPR = 1e9 motes)", () => {
    expect(toMotes(1)).toBe("1000000000");
  });

  it("converte fracionários (2.5 CSPR)", () => {
    expect(toMotes(2.5)).toBe("2500000000");
  });

  it("arredonda drift de float sem vazar precisão (1.1 CSPR)", () => {
    expect(toMotes(1.1)).toBe("1100000000");
  });

  it("zero → 0 motes", () => {
    expect(toMotes(0)).toBe("0");
  });
});

describe("approvalSigners — parse de approvals do JSON", () => {
  it("extrai signers normalizados (lowercase)", () => {
    const json = JSON.stringify({
      approvals: [{ signer: A.toUpperCase() }, { signer: B }],
    });
    expect(approvalSigners(json)).toEqual([A, B]);
  });

  it("sem campo approvals → []", () => {
    expect(approvalSigners('{"foo":1}')).toEqual([]);
  });

  it("JSON malformado → [] (swallow)", () => {
    expect(approvalSigners("lixo{")).toEqual([]);
  });

  it("entradas sem signer são filtradas", () => {
    const json = JSON.stringify({ approvals: [{ signer: A }, {}] });
    expect(approvalSigners(json)).toEqual([A]);
  });
});

describe("buildState — decisão de quórum", () => {
  const meta = (threshold: number) => ({
    from: A,
    to: "01" + "d".repeat(64),
    amountCspr: "3",
    signers: [A, B, C],
    threshold,
  });

  it("conta só assinaturas de signatários exigidos", () => {
    const intruso = "01" + "f".repeat(64);
    const json = JSON.stringify({ approvals: [{ signer: A }, { signer: intruso }] });
    const s = buildState(json, meta(2));
    expect(s.signed).toEqual([A]);
    expect(s.ready).toBe(false);
  });

  it("ready no boundary exato do threshold", () => {
    const json = JSON.stringify({ approvals: [{ signer: A }, { signer: B }] });
    expect(buildState(json, meta(2)).ready).toBe(true);
  });

  it("não fica ready em threshold-1", () => {
    const json = JSON.stringify({ approvals: [{ signer: A }] });
    const s = buildState(json, meta(2));
    expect(s.ready).toBe(false);
    expect(s.pending.sort()).toEqual([B, C].sort());
  });
});

describe("prepareMultisigPayment — clamp de threshold (regressão de bug)", () => {
  // Antes do fix, o threshold NÃO tinha piso de 1: threshold 0/negativo passava
  // por Math.min(0, N) = 0, e buildState fazia ready = (signed >= 0) = SEMPRE
  // true → broadcast sem nenhuma assinatura. Estes testes travam o clamp.
  const base = {
    fromPublicKeyHex: A,
    toPublicKeyHex: "01" + "d".repeat(64),
    amountCspr: 3,
    signerPublicKeysHex: [B, C],
  };

  it("threshold 0 é elevado para 1 (não deixa ready com zero assinaturas)", () => {
    const s = prepareMultisigPayment({ ...base, threshold: 0 });
    expect(s.threshold).toBe(1);
    expect(s.ready).toBe(false); // recém-montada, sem approvals
  });

  it("threshold negativo é elevado para 1", () => {
    expect(prepareMultisigPayment({ ...base, threshold: -5 }).threshold).toBe(1);
  });

  it("threshold acima do nº de signatários é rebaixado ao total", () => {
    // signers = {A(from), B, C} = 3
    const s = prepareMultisigPayment({ ...base, threshold: 99 });
    expect(s.threshold).toBe(3);
  });

  it("threshold ausente → todos os signatários (quórum total)", () => {
    const s = prepareMultisigPayment(base);
    expect(s.threshold).toBe(3);
  });

  it("inclui o pagador nos signatários mesmo se omitido da lista", () => {
    const s = prepareMultisigPayment({
      ...base,
      signerPublicKeysHex: [B], // A (from) não listado explicitamente
    });
    expect(s.signers).toContain(A);
  });
});
