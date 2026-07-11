import { NextResponse } from "next/server";
import {
  exchangeCode,
  fetchUserEmail,
  googleClientId,
  googleClientSecret,
} from "@/server/recall/google-oauth";
import {
  createCalendar,
  reconnectCalendar,
} from "@/server/recall/calendars";
import {
  findCalendarByEmail,
  saveCalendarMapping,
} from "@/server/recall/calendar-repository";
import { verifyOAuthState } from "@/server/recall/oauth-state";
import { withUserScope } from "@/shared/db/rls";

const PLATFORM = "google_calendar" as const;

/**
 * Google OAuth callback.
 *
 * Steps:
 * 1. Verifies the HMAC-signed `state` (verifyOAuthState) and extracts the userId
 *    from it — NEVER trusts the raw query param. Blocks forged account-linking.
 * 2. Exchanges the `code` for a refresh_token + account email.
 * 3. Dedup by (platform, email): if a disconnected calendar already exists,
 *    reconnects it (PATCH); otherwise creates a new one in Recall.
 * 4. Persists the user↔calendar mapping in our DB.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.json({ error: oauthError }, { status: 400 });
  }
  if (!code || !state) {
    return NextResponse.json(
      { error: "missing code or state" },
      { status: 400 },
    );
  }

  // userId comes from the signed and verified state — not the raw query param.
  let userId: string;
  try {
    userId = verifyOAuthState(state);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "invalid_state";
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // Absolute webhook_url derived from the request (or APP_URL if set).
  // Recall BLOCKS (403 request_blocked) localhost/private URLs. In dev,
  // we omit webhook_url (connect still works; updates only via public tunnel).
  // To receive webhooks, point APP_URL to a public https URL (e.g. ngrok).
  const appUrl = process.env.APP_URL ?? url.origin;
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(appUrl);
  const webhookUrl = isLocal ? undefined : `${appUrl}/api/webhooks/recall`;

  try {
    // 1. Google: code → tokens → email
    const tokens = await exchangeCode(code);
    const email = await fetchUserEmail(tokens.accessToken);

    const oauth = {
      oauthClientId: googleClientId(),
      oauthClientSecret: googleClientSecret(),
      oauthRefreshToken: tokens.refreshToken,
      oauthEmail: email,
    };

    // 2. Dedup by (platform, email): reconnect if THIS user already has one
    // (token refresh), otherwise create a new one. Recall doesn't dedup calendars
    // on creation.
    //
    // The lookup + write run under withUserScope so the RLS policies filter to
    // the caller (the DB-level tenant boundary; see drizzle/0008). We ALSO check
    // ownership explicitly below: `findCalendarByEmail` matches on (platform,
    // email) only — two distinct app users can authorize the SAME Google account
    // (shared/service mailbox, account switch, duplicate signup). Reconnecting a
    // row that belongs to ANOTHER user would PATCH the victim's Recall calendar
    // with this caller's refresh token and reassign the row on save — a silent
    // cross-tenant calendar hijack. So we only reconnect a row we actually own;
    // a foreign match is treated as a brand-new calendar for this user.
    await withUserScope(userId, async () => {
      const existing = await findCalendarByEmail(PLATFORM, email);
      const ownedExisting =
        existing && existing.userId === userId ? existing : null;

      const cal = ownedExisting
        ? await reconnectCalendar(ownedExisting.recallCalendarId, oauth)
        : await createCalendar({ platform: PLATFORM, webhookUrl, ...oauth });

      // 3. Persists the mapping (INSERT/UPDATE by recallCalendarId PK). Under the
      // user scope so the WITH CHECK policy accepts it (row belongs to userId).
      await saveCalendarMapping({
        recallCalendarId: cal.id,
        userId,
        platform: PLATFORM,
        platformEmail: cal.platform_email ?? email,
        status: cal.status,
      });
    });

    // Redirects back to the meetings agent UI, signaling the connection.
    return NextResponse.redirect(`${appUrl}/?connected=1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "calendar connect failed", detail: message },
      { status: 502 },
    );
  }
}
