import "server-only";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";

/**
 * Transactional email sending (Resend). External PUSH channel — reaches the
 * user even when logged out (minutes ready, signature request), complementing
 * the in-app bell.
 *
 * Graceful degradation: without RESEND_API_KEY, sendEmail becomes a no-op
 * (logs in dev) and NEVER throws — it must not bring down the bot webhook or
 * request creation. Enabling the channel = setting RESEND_API_KEY and
 * EMAIL_FROM in the env.
 */

const globalForResend = globalThis as unknown as { __resend?: Resend | null };

function getClient(): Resend | null {
  if (globalForResend.__resend !== undefined) return globalForResend.__resend;
  const apiKey = process.env.RESEND_API_KEY;
  globalForResend.__resend = apiKey ? new Resend(apiKey) : null;
  return globalForResend.__resend;
}

/** Configured sender (domain verified in Resend), or the default sandbox. */
function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "CasperAgent <onboarding@resend.dev>";
}

/** Public base URL of the app, to build absolute links in emails. */
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
      console.log(`[email:noop] to ${input.to} — "${input.subject}"`);
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
    // Never propagates: email is best-effort, doesn't block the flow that triggered it.
    console.error(
      `[email] failed to send to ${input.to}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Fetches a user's email by id (better-auth), or null. */
export async function userEmailById(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** Minimal HTML layout, consistent across the product's emails. */
function shell(title: string, body: string, cta?: { label: string; href: string }): string {
  const button = cta
    ? `<a href="${cta.href}" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none;font-family:monospace;font-size:14px">${cta.label}</a>`
    : "";
  return `<div style="max-width:520px;margin:0 auto;font-family:system-ui,sans-serif;color:#111">
    <h2 style="font-size:18px;margin:0 0 8px">${title}</h2>
    <div style="font-size:14px;line-height:1.6;color:#333">${body}</div>
    ${button}
    <p style="margin-top:24px;font-family:monospace;font-size:11px;color:#999">CasperAgent · meetings → verifiable on-chain decisions</p>
  </div>`;
}

/** "Minutes ready" email — triggered by the bot webhook at the end of the meeting. */
export async function emailMeetingSummaryReady(input: {
  userId: string;
  detail: string;
}): Promise<void> {
  const to = await userEmailById(input.userId);
  if (!to) return;
  await sendEmail({
    to,
    subject: "Meeting minutes ready",
    html: shell(
      "Your minutes are ready",
      `The meeting${input.detail} has been processed. Review the summary, decisions, and action items — and turn decisions into on-chain actions (notarize the minutes or prepare a multisig payment).`,
      { label: "Open minutes", href: `${appUrl()}/meetings` },
    ),
  });
}

/** Account verification email (better-auth emailVerification). */
export async function emailVerifyAccount(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Confirm your email — CasperAgent",
    html: shell(
      "Confirm your email",
      "To activate your CasperAgent account, please confirm this email address.",
      { label: "Confirm email", href: input.url },
    ),
  });
}

/** Password reset email (better-auth sendResetPassword). */
export async function emailResetPassword(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Reset password — CasperAgent",
    html: shell(
      "Reset your password",
      "We received a request to reset your password. If this wasn't you, ignore this email.",
      { label: "Create new password", href: input.url },
    ),
  });
}

/** Magic link email (better-auth magicLink plugin). */
export async function emailMagicLink(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Your access link — CasperAgent",
    html: shell(
      "Sign in to CasperAgent",
      "Click the button to sign in. The link expires in a few minutes and can only be used once.",
      { label: "Sign in", href: input.url },
    ),
  });
}

/** Shared body of the signature invitation (in-app user OR external). */
function signatureRequestEmail(input: {
  to: string;
  requestId: string;
  description?: string | null;
}) {
  return {
    to: input.to,
    subject: "You've been called to sign a payment",
    html: shell(
      "Signature requested",
      `You've been added as a signer on a multisig payment${
        input.description ? `: <strong>${input.description}</strong>` : ""
      }. Open the link, connect your wallet, and sign so the payment can move forward to quorum. No account needed — just the wallet.`,
      { label: "Review and sign", href: `${appUrl()}/sign/${input.requestId}` },
    ),
  };
}

/** "You've been called" email — triggered when creating a multisig request. */
export async function emailSignatureRequested(input: {
  userId: string;
  requestId: string;
  description?: string | null;
}): Promise<void> {
  const to = await userEmailById(input.userId);
  if (!to) return;
  await sendEmail(
    signatureRequestEmail({ ...input, to }),
  );
}

/**
 * Invites an EXTERNAL signer (no linked account) via direct email: the
 * creator provided the address when creating the request. Same body as the
 * in-app invitation, but addressed to the email string instead of resolving by userId.
 */
export async function emailExternalSignatureRequested(input: {
  to: string;
  requestId: string;
  description?: string | null;
}): Promise<void> {
  await sendEmail(signatureRequestEmail(input));
}
