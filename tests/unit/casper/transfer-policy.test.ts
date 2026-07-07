import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * transfer-policy (C-2): enforcement de gasto da carteira do AGENTE em código.
 * O módulo lê a política de env no top-level, então cada bloco reconfigura o
 * ambiente e reimporta com módulo fresco (vi.resetModules) antes de exercitar.
 */

async function loadPolicy(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/server/casper/transfer-policy");
}

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("assertTransferAllowed — teto por transação", () => {
  beforeEach(() => {
    delete process.env.AGENT_TRANSFER_ALLOWLIST;
  });

  it("aprova valor dentro do teto default (5 CSPR)", async () => {
    const { assertTransferAllowed } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: undefined,
    });
    expect(() =>
      assertTransferAllowed({ toPublicKeyHex: "01aa", amountCspr: 4.9 }),
    ).not.toThrow();
  });

  it("recusa valor acima do teto", async () => {
    const { assertTransferAllowed, TransferPolicyError } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: "5",
    });
    try {
      assertTransferAllowed({ toPublicKeyHex: "01aa", amountCspr: 5.01 });
      expect.unreachable("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(TransferPolicyError);
      expect((err as InstanceType<typeof TransferPolicyError>).code).toBe(
        "amount_exceeds_limit",
      );
    }
  });

  it("respeita teto customizado via env", async () => {
    const { assertTransferAllowed } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: "100",
    });
    expect(() =>
      assertTransferAllowed({ toPublicKeyHex: "01aa", amountCspr: 99 }),
    ).not.toThrow();
  });
});

describe("assertTransferAllowed — fail-closed em valores inválidos", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])(
    "recusa amount inválido: %s",
    async (amount) => {
      const { assertTransferAllowed, TransferPolicyError } = await loadPolicy({
        AGENT_MAX_TRANSFER_CSPR: "5",
        AGENT_TRANSFER_ALLOWLIST: undefined,
      });
      try {
        assertTransferAllowed({ toPublicKeyHex: "01aa", amountCspr: amount });
        expect.unreachable("deveria ter lançado");
      } catch (err) {
        expect(err).toBeInstanceOf(TransferPolicyError);
        expect((err as InstanceType<typeof TransferPolicyError>).code).toBe(
          "amount_invalid",
        );
      }
    },
  );
});

describe("assertTransferAllowed — allowlist de destinos", () => {
  it("sem allowlist definida, aceita qualquer destino", async () => {
    const { assertTransferAllowed } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: "5",
      AGENT_TRANSFER_ALLOWLIST: undefined,
    });
    expect(() =>
      assertTransferAllowed({ toPublicKeyHex: "09deadbeef", amountCspr: 1 }),
    ).not.toThrow();
  });

  it("com allowlist, aceita destino listado (case-insensitive)", async () => {
    const { assertTransferAllowed } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: "5",
      AGENT_TRANSFER_ALLOWLIST: "01aabb,02ccdd",
    });
    expect(() =>
      assertTransferAllowed({ toPublicKeyHex: "01AABB", amountCspr: 1 }),
    ).not.toThrow();
  });

  it("com allowlist, recusa destino fora dela", async () => {
    const { assertTransferAllowed, TransferPolicyError } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: "5",
      AGENT_TRANSFER_ALLOWLIST: "01aabb",
    });
    try {
      assertTransferAllowed({ toPublicKeyHex: "09ffff", amountCspr: 1 });
      expect.unreachable("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(TransferPolicyError);
      expect((err as InstanceType<typeof TransferPolicyError>).code).toBe(
        "destination_not_allowed",
      );
    }
  });

  it("ordem: teto é checado antes da allowlist", async () => {
    // Destino fora da allowlist E acima do teto → o erro de valor vem primeiro.
    const { assertTransferAllowed, TransferPolicyError } = await loadPolicy({
      AGENT_MAX_TRANSFER_CSPR: "5",
      AGENT_TRANSFER_ALLOWLIST: "01aabb",
    });
    try {
      assertTransferAllowed({ toPublicKeyHex: "09ffff", amountCspr: 999 });
      expect.unreachable("deveria ter lançado");
    } catch (err) {
      expect((err as InstanceType<typeof TransferPolicyError>).code).toBe(
        "amount_exceeds_limit",
      );
    }
  });
});
