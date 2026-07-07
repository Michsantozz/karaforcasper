import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * transferCspr / getBalanceCspr (server/casper/transfer.ts) — o componente que
 * GERA a transação de pagamento (exigência do buildathon). O que garantimos:
 *
 *  - conversão CSPR→motes EXATA (0.1 CSPR = 100_000_000 motes; sem erro de float);
 *  - a policy (teto/allowlist/fail-closed) é chamada ANTES de montar/assinar;
 *  - transferId respeitado quando passado;
 *  - getBalanceCspr: "purse not found" (carteira nova no Testnet) vira "0", mas
 *    outros erros propagam.
 *
 * O SDK Casper e o client (RPC/chave do agente) são mockados — isolamos a
 * aritmética e o fluxo, não a rede.
 */

// Captura os argumentos passados ao builder p/ asserção da conversão de motes.
const built = {
  amount: undefined as string | undefined,
  id: undefined as number | undefined,
  target: undefined as string | undefined,
};
const signSpy = vi.fn();

vi.mock("casper-js-sdk", () => {
  class NativeTransferBuilder {
    from() {
      return this;
    }
    target(pk: { hex: string }) {
      built.target = pk.hex;
      return this;
    }
    amount(m: string) {
      built.amount = m;
      return this;
    }
    id(n: number) {
      built.id = n;
      return this;
    }
    chainName() {
      return this;
    }
    payment() {
      return this;
    }
    build() {
      return { sign: (...a: unknown[]) => signSpy(...a) };
    }
  }
  return {
    NativeTransferBuilder,
    PublicKey: { fromHex: (hex: string) => ({ hex }) },
    PurseIdentifier: { fromPublicKey: (pk: unknown) => pk },
  };
});

const putTransaction = vi.fn();
const queryLatestBalance = vi.fn();
vi.mock("@/server/casper/client", () => ({
  CHAIN_NAME: "casper-test",
  getRpc: () => ({
    putTransaction: (...a: unknown[]) => putTransaction(...a),
    queryLatestBalance: (...a: unknown[]) => queryLatestBalance(...a),
  }),
  getAgentKey: async () => ({ publicKey: { hex: "agent" } }),
}));

// Policy real seria testada à parte; aqui espionamos que É chamada antes de assinar.
const assertTransferAllowed = vi.fn();
vi.mock("@/server/casper/transfer-policy", () => ({
  assertTransferAllowed: (...a: unknown[]) => assertTransferAllowed(...a),
}));

const TO = "0202" + "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks limpa chamadas, não implementações — zera a impl da policy
  // para o "policy lança" de um teste não vazar para os seguintes.
  assertTransferAllowed.mockReset();
  signSpy.mockReset();
  built.amount = undefined;
  built.id = undefined;
  built.target = undefined;
});
afterEach(() => vi.resetModules());

describe("transferCspr — conversão CSPR→motes", () => {
  beforeEach(() => {
    putTransaction.mockResolvedValue({
      transactionHash: { toHex: () => "deadbeef" },
    });
  });

  it("1 CSPR = 1_000_000_000 motes", async () => {
    const { transferCspr } = await import("@/server/casper/transfer");
    await transferCspr({ toPublicKeyHex: TO, amountCspr: 1, transferId: 7 });
    expect(built.amount).toBe("1000000000");
  });

  it("0.1 CSPR = 100_000_000 motes (sem erro de float)", async () => {
    const { transferCspr } = await import("@/server/casper/transfer");
    await transferCspr({ toPublicKeyHex: TO, amountCspr: 0.1, transferId: 7 });
    expect(built.amount).toBe("100000000");
  });

  it("2.5 CSPR = 2_500_000_000 motes (piso de transfer)", async () => {
    const { transferCspr } = await import("@/server/casper/transfer");
    await transferCspr({ toPublicKeyHex: TO, amountCspr: 2.5, transferId: 7 });
    expect(built.amount).toBe("2500000000");
  });
});

describe("transferCspr — fluxo", () => {
  beforeEach(() => {
    putTransaction.mockResolvedValue({
      transactionHash: { toHex: () => "hash123" },
    });
  });

  it("chama a policy ANTES de assinar/submeter", async () => {
    const order: string[] = [];
    assertTransferAllowed.mockImplementation(() => order.push("policy"));
    signSpy.mockImplementation(() => order.push("sign"));
    putTransaction.mockImplementation(async () => {
      order.push("put");
      return { transactionHash: { toHex: () => "h" } };
    });

    const { transferCspr } = await import("@/server/casper/transfer");
    await transferCspr({ toPublicKeyHex: TO, amountCspr: 1, transferId: 1 });

    expect(order[0]).toBe("policy");
    expect(order.indexOf("policy")).toBeLessThan(order.indexOf("sign"));
    expect(order.indexOf("sign")).toBeLessThan(order.indexOf("put"));
    expect(assertTransferAllowed).toHaveBeenCalledWith({
      toPublicKeyHex: TO,
      amountCspr: 1,
    });
  });

  it("policy que lança impede assinar e submeter", async () => {
    assertTransferAllowed.mockImplementation(() => {
      throw new Error("excede o teto");
    });
    const { transferCspr } = await import("@/server/casper/transfer");
    await expect(
      transferCspr({ toPublicKeyHex: TO, amountCspr: 999, transferId: 1 }),
    ).rejects.toThrow(/teto/);
    expect(signSpy).not.toHaveBeenCalled();
    expect(putTransaction).not.toHaveBeenCalled();
  });

  it("usa o transferId informado", async () => {
    const { transferCspr } = await import("@/server/casper/transfer");
    await transferCspr({ toPublicKeyHex: TO, amountCspr: 1, transferId: 4242 });
    expect(built.id).toBe(4242);
  });

  it("retorna hash, valor, destino e chainName", async () => {
    const { transferCspr } = await import("@/server/casper/transfer");
    const res = await transferCspr({
      toPublicKeyHex: TO,
      amountCspr: 3,
      transferId: 1,
    });
    expect(res).toEqual({
      transactionHash: "hash123",
      amountCspr: "3",
      to: TO,
      chainName: "casper-test",
    });
  });
});

describe("getBalanceCspr", () => {
  it("converte motes→CSPR", async () => {
    queryLatestBalance.mockResolvedValue({ balance: { toString: () => "2500000000" } });
    const { getBalanceCspr } = await import("@/server/casper/transfer");
    expect(await getBalanceCspr(TO)).toBe("2.5");
  });

  it("'purse not found' (carteira nova) vira '0'", async () => {
    queryLatestBalance.mockRejectedValue(new Error("Purse not found for account"));
    const { getBalanceCspr } = await import("@/server/casper/transfer");
    expect(await getBalanceCspr(TO)).toBe("0");
  });

  it("outros erros propagam (não mascara falha real de RPC)", async () => {
    queryLatestBalance.mockRejectedValue(new Error("RPC timeout"));
    const { getBalanceCspr } = await import("@/server/casper/transfer");
    await expect(getBalanceCspr(TO)).rejects.toThrow(/RPC timeout/);
  });
});
