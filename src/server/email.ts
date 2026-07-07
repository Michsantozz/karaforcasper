import "server-only";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";

/**
 * Envio de e-mail transacional (Resend). Canal de PUSH externo — alcança o
 * usuário mesmo deslogado (ata pronta, convocação para assinar), complementando
 * o sino in-app.
 *
 * Degradação graciosa: sem RESEND_API_KEY, sendEmail vira no-op (loga em dev) e
 * NUNCA lança — não pode derrubar o webhook de bot nem a criação de request.
 * Ligar o canal = definir RESEND_API_KEY e EMAIL_FROM no env.
 */

const globalForResend = globalThis as unknown as { __resend?: Resend | null };

function getClient(): Resend | null {
  if (globalForResend.__resend !== undefined) return globalForResend.__resend;
  const apiKey = process.env.RESEND_API_KEY;
  globalForResend.__resend = apiKey ? new Resend(apiKey) : null;
  return globalForResend.__resend;
}

/** Remetente configurado (domínio verificado no Resend), ou o sandbox padrão. */
function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "CasperAgent <onboarding@resend.dev>";
}

/** URL base pública do app, para montar links absolutos nos e-mails. */
function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "http://localhost:3000"
  );
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const client = getClient();
  if (!client) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[email:noop] para ${input.to} — "${input.subject}"`);
    }
    return;
  }
  try {
    await client.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
  } catch (err) {
    // Nunca propaga: e-mail é best-effort, não bloqueia o fluxo que o disparou.
    console.error(
      `[email] falha ao enviar para ${input.to}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Busca o e-mail de um usuário pelo id (better-auth), ou null. */
export async function userEmailById(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** Layout HTML mínimo, consistente entre os e-mails do produto. */
function shell(title: string, body: string, cta?: { label: string; href: string }): string {
  const button = cta
    ? `<a href="${cta.href}" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none;font-family:monospace;font-size:14px">${cta.label}</a>`
    : "";
  return `<div style="max-width:520px;margin:0 auto;font-family:system-ui,sans-serif;color:#111">
    <h2 style="font-size:18px;margin:0 0 8px">${title}</h2>
    <div style="font-size:14px;line-height:1.6;color:#333">${body}</div>
    ${button}
    <p style="margin-top:24px;font-family:monospace;font-size:11px;color:#999">CasperAgent · reuniões → decisões verificáveis on-chain</p>
  </div>`;
}

/** E-mail "ata pronta" — disparado pelo webhook de bot ao fim da reunião. */
export async function emailMeetingSummaryReady(input: {
  userId: string;
  detail: string;
}): Promise<void> {
  const to = await userEmailById(input.userId);
  if (!to) return;
  await sendEmail({
    to,
    subject: "Ata da reunião pronta",
    html: shell(
      "Sua ata está pronta",
      `A reunião foi processada${input.detail}. Revise o resumo, as decisões e as tarefas — e transforme decisões em ações on-chain (notarizar a ata ou preparar um pagamento multisig).`,
      { label: "Abrir ata", href: `${appUrl()}/meetings` },
    ),
  });
}

/** E-mail de verificação de conta (better-auth emailVerification). */
export async function emailVerifyAccount(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Confirme seu e-mail — CasperAgent",
    html: shell(
      "Confirme seu e-mail",
      "Para ativar sua conta no CasperAgent, confirme este endereço de e-mail.",
      { label: "Confirmar e-mail", href: input.url },
    ),
  });
}

/** E-mail de reset de senha (better-auth sendResetPassword). */
export async function emailResetPassword(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Redefinir senha — CasperAgent",
    html: shell(
      "Redefinir sua senha",
      "Recebemos um pedido para redefinir sua senha. Se não foi você, ignore este e-mail.",
      { label: "Criar nova senha", href: input.url },
    ),
  });
}

/** E-mail com magic link (better-auth magicLink plugin). */
export async function emailMagicLink(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Seu link de acesso — CasperAgent",
    html: shell(
      "Entrar no CasperAgent",
      "Clique no botão para entrar. O link expira em alguns minutos e só pode ser usado uma vez.",
      { label: "Entrar", href: input.url },
    ),
  });
}

/** E-mail "você foi convocado" — disparado ao criar uma request multisig. */
export async function emailSignatureRequested(input: {
  userId: string;
  requestId: string;
  description?: string | null;
}): Promise<void> {
  const to = await userEmailById(input.userId);
  if (!to) return;
  await sendEmail({
    to,
    subject: "Você foi convocado para assinar um pagamento",
    html: shell(
      "Assinatura solicitada",
      `Você foi adicionado como signatário de um pagamento multisig${
        input.description ? `: <strong>${input.description}</strong>` : ""
      }. Conecte sua carteira e assine para que o pagamento avance até o quórum.`,
      { label: "Revisar e assinar", href: `${appUrl()}/sign/${input.requestId}` },
    ),
  });
}
