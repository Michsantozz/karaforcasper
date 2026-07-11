import "server-only";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";
import { appPublicUrl } from "@/shared/lib/config";

/**
 * Transactional email sending (Resend). External PUSH channel — reaches the
 * user even when logged out (minutes ready), complementing the in-app bell.
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
  return appPublicUrl();
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

/** Fetches a user's display name + email by id (better-auth), or null. */
export async function userIdentityById(
  userId: string,
): Promise<{ name: string | null; email: string } | null> {
  const rows = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? { name: row.name ?? null, email: row.email } : null;
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
    <p style="margin-top:24px;font-family:monospace;font-size:11px;color:#999">CasperAgent · meetings, recorded and summarized</p>
  </div>`;
}

/** "Minutes ready" email — triggered by the bot webhook at the end of the meeting. */
export async function emailMeetingSummaryReady(input: {
  userId: string;
  detail: string;
  /** Bot id, for the deep link straight to the meeting notebook. */
  botId?: string;
}): Promise<void> {
  const to = await userEmailById(input.userId);
  if (!to) return;
  // Deep-link to the meeting notebook when we know the bot; else the index.
  const href = input.botId
    ? `${appUrl()}/meetings/${input.botId}`
    : `${appUrl()}/meetings`;
  await sendEmail({
    to,
    subject: "Meeting minutes ready",
    html: shell(
      "Your minutes are ready",
      `The meeting${input.detail} has been processed. Review the summary, decisions, and action items.`,
      { label: "Open minutes", href },
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

/** Escapes text for safe interpolation into the email HTML body. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Structured meeting summary the recipient email renders (subset of MeetingSummary). */
export type SummaryEmailContent = {
  summary: string | null;
  overview?: string | null;
  decisions?: string[] | null;
  actionItems?: Array<{ task: string; owner: string | null }> | null;
  topics?: string[] | null;
};

/** Renders the summary sections as the email body's inner HTML. */
function renderSummaryBody(content: SummaryEmailContent): string {
  const blocks: string[] = [];
  const heading = (t: string) =>
    `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#666;margin:20px 0 6px">${t}</h3>`;

  const body = content.overview?.trim() || content.summary?.trim();
  if (body) blocks.push(`<p style="margin:0 0 8px">${esc(body)}</p>`);

  if (content.decisions?.length) {
    blocks.push(heading("Decisions"));
    blocks.push(
      `<ul style="margin:0;padding-left:18px">${content.decisions
        .map((d) => `<li>${esc(d)}</li>`)
        .join("")}</ul>`,
    );
  }

  if (content.actionItems?.length) {
    blocks.push(heading("Action items"));
    blocks.push(
      `<ul style="margin:0;padding-left:18px">${content.actionItems
        .map(
          (a) =>
            `<li>${esc(a.task)}${a.owner ? ` <span style="color:#666">— ${esc(a.owner)}</span>` : ""}</li>`,
        )
        .join("")}</ul>`,
    );
  }

  if (content.topics?.length) {
    blocks.push(heading("Topics"));
    blocks.push(
      `<p style="margin:0;color:#333">${content.topics.map(esc).join(" · ")}</p>`,
    );
  }

  return blocks.join("");
}

/**
 * "Someone shared meeting minutes with you" email — sent to an ARBITRARY
 * recipient chosen by the meeting owner (e.g. a manager who didn't attend).
 *
 * Transparency (anti-phishing): the subject and body name WHO shared it, so the
 * recipient sees a real person behind the send, not an anonymous blast. There is
 * no deep link into the app — the recipient may not have an account — only the
 * summary content itself.
 */
export async function emailMeetingSummaryToRecipient(input: {
  to: string;
  /** Display name of the owner who is sharing (falls back to their email). */
  senderName: string;
  /** Human title/label for the meeting (falls back to a generic label). */
  meetingTitle: string;
  content: SummaryEmailContent;
  /** Optional free-text note the sender added. */
  note?: string;
}): Promise<void> {
  const noteHtml = input.note?.trim()
    ? `<p style="margin:0 0 12px;padding:10px 12px;background:#f4f4f5;border-radius:6px;font-style:italic;color:#333">${esc(input.note.trim())}</p>`
    : "";
  const intro = `<p style="margin:0 0 12px;color:#666">${esc(input.senderName)} shared the minutes of <strong style="color:#111">${esc(input.meetingTitle)}</strong> with you via CasperAgent.</p>`;

  await sendEmail({
    to: input.to,
    subject: `${input.senderName} shared meeting minutes: ${input.meetingTitle}`,
    html: shell(
      "Meeting minutes",
      intro + noteHtml + renderSummaryBody(input.content),
    ),
  });
}
