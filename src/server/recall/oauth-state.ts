import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed `state` for calendar OAuth (CSRF / account-linking).
 *
 * Previously the callback used the raw `state` as userId, WITHOUT session or
 * verification: an attacker would start their own flow, capture their `code`,
 * and call /callback?code=THEIR_CODE&state=VICTIM_ID — linking their own
 * calendar to the victim's account. Here `state` is an HMAC-signed token that
 * binds the userId (from the /start session) + nonce + expiration; the
 * callback validates the signature and validity BEFORE trusting the userId.
 * Without the secret, the token can't be forged.
 */

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: OAUTH_STATE_SECRET");
  }
  return secret;
}

const TTL_MS = 10 * 60 * 1000; // 10 min — consent screen window.

function sign(payload: string): string {
  return createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

/** Generates a signed `state` for the userId (called in /start, authenticated). */
export function signOAuthState(userId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + TTL_MS;
  const payload = `${userId}.${nonce}.${exp}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/**
 * Validates the callback's `state` and returns the embedded userId. Throws if
 * the signature doesn't match (timing-safe comparison) or the token has expired.
 */
export function verifyOAuthState(state: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid_state");
  }

  const parts = decoded.split(".");
  if (parts.length !== 4) throw new Error("invalid_state");
  const [userId, nonce, exp, sig] = parts;

  const expected = sign(`${userId}.${nonce}.${exp}`);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("invalid_state");
  }

  if (!Number.isFinite(Number(exp)) || Date.now() > Number(exp)) {
    throw new Error("state_expired");
  }

  return userId;
}
