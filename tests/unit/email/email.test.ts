import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Canal de e-mail transacional (server/email.ts). Duas garantias críticas:
 *
 *  1. Degradação graciosa: sem RESEND_API_KEY, sendEmail é no-op e NUNCA lança —
 *     não pode derrubar o webhook de bot nem a criação de request multisig.
 *  2. Com key, chama o SDK Resend com from/to/subject/html corretos; e se o SDK
 *     lançar, o erro é engolido (best-effort), sem propagar ao chamador.
 *
 * Mockamos `resend` (SDK) e `@/shared/db` (userEmailById) para isolar a lógica.
 */

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...a: unknown[]) => send(...a) };
  },
}));

// db.select().from().where().limit() → linhas. Encadeamento fluente mockado.
const limit = vi.fn();
vi.mock("@/shared/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...a: unknown[]) => limit(...a),
        }),
      }),
    }),
  },
}));
vi.mock("@/shared/db/auth-schema", () => ({ user: { id: "id", email: "email" } }));

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  limit.mockReset();
  // Cache de cliente Resend vive em globalThis.__resend — zera entre testes.
  delete (globalThis as { __resend?: unknown }).__resend;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  delete (globalThis as { __resend?: unknown }).__resend;
});

describe("sendEmail — degradação graciosa sem RESEND_API_KEY", () => {
  it("é no-op (não chama o SDK) e não lança quando não há key", async () => {
    const { sendEmail } = await import("@/server/email");
    await expect(
      sendEmail({ to: "a@b.com", subject: "x", html: "<p>x</p>" }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendEmail — com RESEND_API_KEY", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("chama o SDK com from/to/subject/html", async () => {
    send.mockResolvedValue({ id: "email_1" });
    const { sendEmail } = await import("@/server/email");
    await sendEmail({ to: "dest@x.com", subject: "Assunto", html: "<b>oi</b>" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dest@x.com",
        subject: "Assunto",
        html: "<b>oi</b>",
      }),
    );
  });

  it("usa EMAIL_FROM quando definido, senão o sandbox onboarding@resend.dev", async () => {
    send.mockResolvedValue({ id: "email_1" });

    // 1ª chamada: sem EMAIL_FROM → sandbox.
    let mod = await import("@/server/email");
    await mod.sendEmail({ to: "a@b.com", subject: "s", html: "h" });
    expect(send.mock.calls[0][0].from).toContain("onboarding@resend.dev");

    // 2ª: com EMAIL_FROM. Reset de módulos + cache p/ novo cliente pegar a env.
    vi.resetModules();
    delete (globalThis as { __resend?: unknown }).__resend;
    send.mockReset();
    send.mockResolvedValue({ id: "email_2" });
    process.env.EMAIL_FROM = "CasperAgent <no-reply@ultraself.com.br>";
    mod = await import("@/server/email");
    await mod.sendEmail({ to: "a@b.com", subject: "s", html: "h" });
    expect(send.mock.calls[0][0].from).toBe(
      "CasperAgent <no-reply@ultraself.com.br>",
    );
  });

  it("engole erro do SDK (best-effort) sem propagar", async () => {
    send.mockRejectedValue(new Error("Resend 500"));
    const { sendEmail } = await import("@/server/email");
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", html: "h" }),
    ).resolves.toBeUndefined();
  });
});

describe("userEmailById", () => {
  it("retorna o e-mail quando a linha existe", async () => {
    limit.mockResolvedValue([{ email: "user@x.com" }]);
    const { userEmailById } = await import("@/server/email");
    expect(await userEmailById("u1")).toBe("user@x.com");
  });

  it("retorna null quando não há linha", async () => {
    limit.mockResolvedValue([]);
    const { userEmailById } = await import("@/server/email");
    expect(await userEmailById("nope")).toBeNull();
  });
});

describe("templates transacionais", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  it("emailMagicLink: assunto de acesso + link no HTML", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailMagicLink } = await import("@/server/email");
    await emailMagicLink({ to: "a@b.com", url: "https://link/magic?token=abc" });
    const call = send.mock.calls[0][0];
    expect(call.subject).toMatch(/link de acesso/i);
    expect(call.html).toContain("https://link/magic?token=abc");
  });

  it("emailResetPassword: assunto de reset + link no HTML", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailResetPassword } = await import("@/server/email");
    await emailResetPassword({ to: "a@b.com", url: "https://link/reset?t=1" });
    const call = send.mock.calls[0][0];
    expect(call.subject).toMatch(/redefinir senha/i);
    expect(call.html).toContain("https://link/reset?t=1");
  });

  it("emailMeetingSummaryReady: resolve o e-mail do dono e aponta para /meetings", async () => {
    limit.mockResolvedValue([{ email: "owner@x.com" }]);
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryReady } = await import("@/server/email");
    await emailMeetingSummaryReady({ userId: "u1", detail: " (30 min)" });
    const call = send.mock.calls[0][0];
    expect(call.to).toBe("owner@x.com");
    expect(call.html).toContain("https://app.example.com/meetings");
  });

  it("emailMeetingSummaryReady: sem e-mail do dono, não envia", async () => {
    limit.mockResolvedValue([]);
    const { emailMeetingSummaryReady } = await import("@/server/email");
    await emailMeetingSummaryReady({ userId: "ghost", detail: "" });
    expect(send).not.toHaveBeenCalled();
  });

  it("emailSignatureRequested: aponta para /sign/:requestId", async () => {
    limit.mockResolvedValue([{ email: "signer@x.com" }]);
    send.mockResolvedValue({ id: "e" });
    const { emailSignatureRequested } = await import("@/server/email");
    await emailSignatureRequested({
      userId: "u1",
      requestId: "req-42",
      description: "Pagar fornecedor",
    });
    const call = send.mock.calls[0][0];
    expect(call.to).toBe("signer@x.com");
    expect(call.html).toContain("https://app.example.com/sign/req-42");
    expect(call.html).toContain("Pagar fornecedor");
  });
});
