import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * oauth-state (C-1): `state` HMAC-assinado do OAuth de calendar. Impede o
 * account-linking forjado — o callback só confia no userId que sai daqui.
 * O secret é lido em cada sign/verify, então basta setar a env antes.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.OAUTH_STATE_SECRET = "unit-test-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("signOAuthState / verifyOAuthState", () => {
  it("round-trip: verify devolve o userId assinado", async () => {
    const { signOAuthState, verifyOAuthState } = await import(
      "@/server/recall/oauth-state"
    );
    const state = signOAuthState("user-42");
    expect(verifyOAuthState(state)).toBe("user-42");
  });

  it("bloqueia state forjado (troca do userId sem o secret)", async () => {
    const { signOAuthState, verifyOAuthState } = await import(
      "@/server/recall/oauth-state"
    );
    const legit = signOAuthState("attacker-id");
    // Atacante decodifica, troca o userId, re-encoda mantendo a assinatura antiga.
    const [, nonce, exp, sig] = Buffer.from(legit, "base64url")
      .toString("utf8")
      .split(".");
    const forged = Buffer.from(
      `victim-id.${nonce}.${exp}.${sig}`,
    ).toString("base64url");

    expect(() => verifyOAuthState(forged)).toThrow("invalid_state");
  });

  it("bloqueia state assinado com outro secret", async () => {
    const { signOAuthState } = await import("@/server/recall/oauth-state");
    const state = signOAuthState("user-1");

    // Reimporta com secret diferente → assinatura não bate.
    vi.resetModules();
    process.env.OAUTH_STATE_SECRET = "outro-secret";
    const { verifyOAuthState } = await import("@/server/recall/oauth-state");
    expect(() => verifyOAuthState(state)).toThrow("invalid_state");
  });

  it("recusa state expirado", async () => {
    const { verifyOAuthState } = await import("@/server/recall/oauth-state");
    // Fabrica um token com exp no passado, assinado corretamente.
    const { createHmac } = await import("node:crypto");
    const exp = Date.now() - 1000;
    const payload = `user-1.abc.${exp}`;
    const sig = createHmac("sha256", process.env.OAUTH_STATE_SECRET!)
      .update(payload)
      .digest("base64url");
    const state = Buffer.from(`${payload}.${sig}`).toString("base64url");

    expect(() => verifyOAuthState(state)).toThrow("state_expired");
  });

  it("recusa lixo não decodificável", async () => {
    const { verifyOAuthState } = await import("@/server/recall/oauth-state");
    expect(() => verifyOAuthState("!!!not-a-token")).toThrow("invalid_state");
  });

  it("recusa token com número de partes errado", async () => {
    const { verifyOAuthState } = await import("@/server/recall/oauth-state");
    const bad = Buffer.from("only.two.parts").toString("base64url");
    expect(() => verifyOAuthState(bad)).toThrow("invalid_state");
  });

  it("lança se OAUTH_STATE_SECRET não estiver configurado", async () => {
    delete process.env.OAUTH_STATE_SECRET;
    const { signOAuthState } = await import("@/server/recall/oauth-state");
    expect(() => signOAuthState("user-1")).toThrow(/OAUTH_STATE_SECRET/);
  });

  it("nonces distintos por chamada (states diferentes p/ mesmo userId)", async () => {
    const { signOAuthState } = await import("@/server/recall/oauth-state");
    const a = signOAuthState("user-1");
    const b = signOAuthState("user-1");
    expect(a).not.toBe(b);
  });
});
