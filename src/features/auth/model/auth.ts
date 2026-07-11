import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { db } from "@/shared/db";
import {
  emailVerifyAccount,
  emailResetPassword,
  emailMagicLink,
} from "@/server/email";
import { encryptToken } from "@/server/crypto/token-cipher";

/**
 * better-auth configuration (app identity/session).
 *
 * Social sign-in with Google. `accessType: offline` + `prompt` with `consent`
 * ensure the linked account has a refresh_token — used later to connect the
 * user's calendar to Recall (the calendar flow is separate but reuses the
 * same Google OAuth client).
 *
 * Tables (user/session/account/verification/rateLimit) generated via the
 * `better-auth` CLI and versioned in the Drizzle schema. After changing
 * rateLimit.storage="database" run the better-auth schema/migration
 * generation to create the rateLimit table.
 */

// Email verification is only REQUIRED when an email provider is configured
// (REQUIRE_EMAIL_VERIFICATION=true). Without SMTP/provider, requiring it would
// lock sign-in — so the default is off, but the wiring is ready: just flip
// the flag and plug in a real provider instead of the console.log.
const requireEmailVerification =
  process.env.REQUIRE_EMAIL_VERIFICATION === "true";

// Trusted origins (better-auth CSRF/origin check). Includes the production
// domain (env) + localhost on dev ports, so the same build works both
// through the tunnel and accessed directly on localhost.
const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.NEXT_PUBLIC_APP_URL,
  "https://casper.careglyph.com",
  "http://localhost:3000",
  "http://localhost:3009",
].filter((v): v is string => Boolean(v));

// Encrypts the token columns of an account record in place (only the fields
// that are present). `account` here is better-auth's partial write payload, so
// we accept a loose shape and touch only accessToken/refreshToken.
function encryptAccountTokens<
  T extends { accessToken?: string | null; refreshToken?: string | null },
>(account: T): T {
  const next = { ...account };
  if (account.accessToken) next.accessToken = encryptToken(account.accessToken);
  if (account.refreshToken)
    next.refreshToken = encryptToken(account.refreshToken);
  return next;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  trustedOrigins,
  // Encrypt third-party OAuth tokens at rest (finding A). better-auth stores
  // account.accessToken/refreshToken in plaintext by default; a DB dump would
  // leak every user's Google tokens. These hooks wrap them with AES-256-GCM
  // before persisting (create + refresh/update). No read hook is needed: the
  // app never reads these columns back — the calendar refresh_token flows
  // straight from the OAuth exchange to Recall, not through this table. If a
  // future code path DOES need the plaintext, use decryptToken() on read.
  // encryptToken is a no-op passthrough when ACCOUNT_TOKEN_ENCRYPTION_KEY is
  // unset (dev) and idempotent on already-encrypted values.
  databaseHooks: {
    account: {
      create: {
        async before(account) {
          return { data: encryptAccountTokens(account) };
        },
      },
      update: {
        async before(account) {
          return { data: encryptAccountTokens(account) };
        },
      },
    },
  },
  // Signed cookie cache — avoids a DB read on every getSession() (RSC/routes/
  // tools all call it). Short maxAge keeps revocation lag low; DB stays the
  // source of truth once the cache expires.
  session: {
    cookieCache: { enabled: true, maxAge: 300 },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification,
    // Password reset via Resend (forget → email → /reset-password flow).
    sendResetPassword: async ({ user, url }) => {
      await emailResetPassword({ to: user.email, url });
    },
  },
  emailVerification: {
    sendOnSignIn: requireEmailVerification,
    sendVerificationEmail: async ({ user, url }) => {
      await emailVerifyAccount({ to: user.email, url });
    },
  },
  // Native rate limiting — covers login/signup (which Twenty does NOT do).
  // Stricter rules on credential endpoints to slow brute-force and enumeration.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
      "/forget-password": { window: 60, max: 3 },
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      accessType: "offline",
      prompt: "select_account consent",
    },
  },
  plugins: [
    // Magic link sign-in (passwordless email). Sent via Resend.
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await emailMagicLink({ to: email, url });
      },
    }),
    // nextCookies must be the LAST plugin (it intercepts Set-Cookie on responses).
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
