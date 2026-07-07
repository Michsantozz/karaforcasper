import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * prepareMultisigSetup (server/casper/multisig-setup.ts) — monta a sequência de
 * deploys que transforma a conta primária num multisig NATIVO do Casper. O que
 * garantimos (errar aqui TRAVA a conta on-chain, irreversível):
 *
 *  - ORDEM obrigatória dos passos: (0) elevar peso da primária → (1..N) add
 *    cada associado → (último) definir thresholds. Inverter quebra o setup.
 *  - contagem: 1 + nº de associados + 1;
 *  - primaryWeight default = keyManagementThreshold (senão a conta não consegue
 *    se gerenciar e trava);
 *  - config espelha os argumentos.
 *
 * Os .wasm são carregados DE VERDADE do disco (valida o path WASM_DIR —
 * regressão do bug src/lib → src/server pós-migração de arquitetura).
 * SessionBuilder e tx-store são mockados para isolar a montagem.
 */

vi.mock("casper-js-sdk", () => {
  class SessionBuilder {
    from() {
      return this;
    }
    wasm() {
      return this;
    }
    runtimeArgs() {
      return this;
    }
    chainName() {
      return this;
    }
    payment() {
      return this;
    }
    build() {
      return { toJSON: () => ({ fake: "tx" }) };
    }
  }
  return {
    SessionBuilder,
    Args: { fromMap: (m: unknown) => m },
    CLValue: {
      newCLKey: (k: unknown) => k,
      newCLUint8: (n: number) => n,
    },
    Key: { newKey: (s: string) => s },
    PublicKey: {
      fromHex: (hex: string) => ({
        hex,
        accountHash: () => ({ toPrefixedString: () => `account-hash-${hex.slice(0, 6)}` }),
      }),
    },
  };
});

// tx-store: captura os metadados e devolve ids sequenciais previsíveis.
const putCalls: Array<{ json: string; meta: unknown }> = [];
let seq = 0;
vi.mock("@/server/casper/tx-store", () => ({
  putTx: (json: string, meta: unknown) => {
    putCalls.push({ json, meta });
    return `tx-${seq++}`;
  },
}));

vi.mock("@/server/casper/client", () => ({ CHAIN_NAME: "casper-test" }));

const PRIMARY = "0101" + "a".repeat(62);
const A1 = "0202" + "b".repeat(62);
const A2 = "0203" + "c".repeat(62);

beforeEach(() => {
  putCalls.length = 0;
  seq = 0;
});
afterEach(() => vi.resetModules());

describe("prepareMultisigSetup — ordem e contagem", () => {
  it("monta 1 (peso) + N (add) + 1 (thresholds) passos, nessa ordem", async () => {
    const { prepareMultisigSetup } = await import("@/server/casper/multisig-setup");
    const out = await prepareMultisigSetup({
      primaryPublicKeyHex: PRIMARY,
      associates: [
        { publicKeyHex: A1, weight: 1 },
        { publicKeyHex: A2, weight: 1 },
      ],
      deploymentThreshold: 2,
      keyManagementThreshold: 3,
    });

    // 1 + 2 associados + 1 = 4 passos.
    expect(out.steps).toHaveLength(4);
    expect(out.steps[0].label).toMatch(/elevar peso da chave primária/i);
    expect(out.steps[1].label).toMatch(/adicionar/i);
    expect(out.steps[2].label).toMatch(/adicionar/i);
    expect(out.steps[3].label).toMatch(/definir quórum/i);
  });

  it("sem associados: só peso + thresholds (2 passos)", async () => {
    const { prepareMultisigSetup } = await import("@/server/casper/multisig-setup");
    const out = await prepareMultisigSetup({
      primaryPublicKeyHex: PRIMARY,
      associates: [],
      deploymentThreshold: 1,
      keyManagementThreshold: 1,
    });
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0].label).toMatch(/elevar peso/i);
    expect(out.steps[1].label).toMatch(/definir quórum/i);
  });

  it("cada passo referencia uma tx persistida no store, com kind setup_multisig", async () => {
    const { prepareMultisigSetup } = await import("@/server/casper/multisig-setup");
    const out = await prepareMultisigSetup({
      primaryPublicKeyHex: PRIMARY,
      associates: [{ publicKeyHex: A1, weight: 1 }],
      deploymentThreshold: 1,
      keyManagementThreshold: 1,
    });
    expect(out.steps.map((s) => s.txId)).toEqual(["tx-0", "tx-1", "tx-2"]);
    for (const call of putCalls) {
      expect((call.meta as { kind: string }).kind).toBe("setup_multisig");
    }
  });
});

describe("prepareMultisigSetup — segurança do peso da primária", () => {
  it("primaryWeight default = keyManagementThreshold (evita travar a conta)", async () => {
    const { prepareMultisigSetup } = await import("@/server/casper/multisig-setup");
    const out = await prepareMultisigSetup({
      primaryPublicKeyHex: PRIMARY,
      associates: [],
      deploymentThreshold: 2,
      keyManagementThreshold: 3,
    });
    expect(out.config.primaryWeight).toBe(3);
    expect(out.steps[0].label).toContain("3");
  });

  it("primaryWeight explícito é respeitado", async () => {
    const { prepareMultisigSetup } = await import("@/server/casper/multisig-setup");
    const out = await prepareMultisigSetup({
      primaryPublicKeyHex: PRIMARY,
      associates: [],
      deploymentThreshold: 1,
      keyManagementThreshold: 2,
      primaryWeight: 5,
    });
    expect(out.config.primaryWeight).toBe(5);
  });
});

describe("prepareMultisigSetup — config de saída", () => {
  it("espelha thresholds, associados e chainName", async () => {
    const { prepareMultisigSetup } = await import("@/server/casper/multisig-setup");
    const associates = [{ publicKeyHex: A1, weight: 2 }];
    const out = await prepareMultisigSetup({
      primaryPublicKeyHex: PRIMARY,
      associates,
      deploymentThreshold: 2,
      keyManagementThreshold: 2,
    });
    expect(out.primaryPublicKeyHex).toBe(PRIMARY);
    expect(out.chainName).toBe("casper-test");
    expect(out.config).toMatchObject({
      associatedKeys: associates,
      deploymentThreshold: 2,
      keyManagementThreshold: 2,
    });
  });
});
