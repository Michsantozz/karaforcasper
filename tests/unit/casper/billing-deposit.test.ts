import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * verifyAndCreditDeposit (server/casper/billing-deposit.ts) — verificação de
 * depósito on-chain → crédito no ledger. A regra crítica de segurança: o crédito
 * só ocorre se o REMETENTE da tx (quem assinou on-chain) for uma carteira
 * VERIFICADA do próprio usuário. Sem isso, qualquer autenticado creditaria em si
 * um depósito alheio informando o txHash público (deposit hijack — finding #1).
 *
 * O RPC, a pubkey do app, o resolvedor carteira→user e o creditDeposit são
 * mockados: isolamos a lógica de autorização do remetente, não a rede/DB.
 */

const APP_PUBKEY = "01appappappappapp";
const ALICE_WALLET = "01aaaaaaaaaaaaaa";
const BOB_WALLET = "01bbbbbbbbbbbbbb";

// Estado controlável pelo teste, lido pelos mocks.
const state = {
  txJson: "" as string,
  // mapa carteira(normalizada) → userId verificado
  walletOwners: new Map<string, string>(),
};

const creditDepositSpy = vi.fn(async (_input: unknown) => true);

vi.mock("@/server/casper/client", () => ({
  getRpc: () => ({
    getTransactionByTransactionHash: async () => ({
      transaction: { toJSON: () => JSON.parse(state.txJson) },
    }),
  }),
  getAgentPublicKeyHex: async () => APP_PUBKEY,
}));

vi.mock("@/server/casper/billing", () => ({
  MOTES_PER_CSPR: 1_000_000_000n,
  creditDeposit: (input: unknown) => creditDepositSpy(input),
}));

vi.mock("@/server/casper/user-wallets", () => ({
  resolveUserByWallet: async (pk: string) =>
    state.walletOwners.get(pk.toLowerCase()) ?? null,
}));

// approvalSigners é lógica pura de parsing do JSON — não mockamos, usamos a real.
import { verifyAndCreditDeposit } from "@/server/casper/billing-deposit";

/** Monta um JSON de tx com destino = app, valor e a lista de signers dada. */
function txWith(signers: string[], amountHex = "0400ca9a3b" /* 1 CSPR U512 */) {
  return JSON.stringify({
    // O destino (app) precisa aparecer no blob.
    target: { account: APP_PUBKEY },
    args: [["amount", { bytes: amountHex, cl_type: "U512" }]],
    approvals: signers.map((signer) => ({ signer, signature: "01deadbeef" })),
  });
}

describe("verifyAndCreditDeposit — autorização do remetente (anti-hijack)", () => {
  beforeEach(() => {
    creditDepositSpy.mockClear();
    state.walletOwners = new Map();
  });

  it("credita quando o remetente é carteira verificada do próprio usuário", async () => {
    state.walletOwners.set(ALICE_WALLET, "alice");
    state.txJson = txWith([ALICE_WALLET]);

    const res = await verifyAndCreditDeposit({
      txHash: "abc",
      userId: "alice",
    });

    expect(res.credited).toBe(true);
    expect(creditDepositSpy).toHaveBeenCalledOnce();
  });

  it("REJEITA quando Bob tenta creditar depósito assinado pela carteira da Alice", async () => {
    // Alice depositou (assinou a tx); Bob, autenticado, informa o mesmo txHash.
    state.walletOwners.set(ALICE_WALLET, "alice");
    state.txJson = txWith([ALICE_WALLET]);

    const res = await verifyAndCreditDeposit({ txHash: "abc", userId: "bob" });

    expect(res.credited).toBe(false);
    expect(res.reason).toMatch(/sender wallet is not a verified wallet/i);
    expect(creditDepositSpy).not.toHaveBeenCalled();
  });

  it("REJEITA quando o remetente não é carteira vinculada de ninguém", async () => {
    // Carteira não verificada por nenhum usuário → fail-closed.
    state.txJson = txWith([BOB_WALLET]);

    const res = await verifyAndCreditDeposit({ txHash: "abc", userId: "bob" });

    expect(res.credited).toBe(false);
    expect(creditDepositSpy).not.toHaveBeenCalled();
  });

  it("REJEITA quando a tx não tem signers (não dá para atribuir remetente)", async () => {
    state.txJson = txWith([]);

    const res = await verifyAndCreditDeposit({ txHash: "abc", userId: "alice" });

    expect(res.credited).toBe(false);
    expect(res.reason).toMatch(/could not read transaction sender/i);
    expect(creditDepositSpy).not.toHaveBeenCalled();
  });

  it("REJEITA quando o destino não é a conta do app", async () => {
    state.walletOwners.set(ALICE_WALLET, "alice");
    state.txJson = JSON.stringify({
      target: { account: "01someotheraccount" },
      args: [["amount", { bytes: "0400ca9a3b", cl_type: "U512" }]],
      approvals: [{ signer: ALICE_WALLET, signature: "01deadbeef" }],
    });

    const res = await verifyAndCreditDeposit({ txHash: "abc", userId: "alice" });

    expect(res.credited).toBe(false);
    expect(res.reason).toMatch(/not the app account/i);
    expect(creditDepositSpy).not.toHaveBeenCalled();
  });
});
