import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `state` assinado para o OAuth de calendar (CSRF / account-linking).
 *
 * Antes o callback usava o `state` cru como userId, SEM sessão nem verificação:
 * um atacante iniciava o próprio fluxo, capturava seu `code`, e chamava
 * /callback?code=SEU_CODE&state=ID_DA_VÍTIMA — vinculando a própria agenda à
 * conta da vítima. Aqui o `state` é um token HMAC-assinado que amarra o userId
 * (da sessão em /start) + nonce + expiração; o callback valida a assinatura e a
 * validade ANTES de confiar no userId. Sem o secret, o token não pode ser forjado.
 */

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: OAUTH_STATE_SECRET");
  }
  return secret;
}

const TTL_MS = 10 * 60 * 1000; // 10 min — janela do consent screen.

function sign(payload: string): string {
  return createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

/** Gera um `state` assinado para o userId (chamado em /start, autenticado). */
export function signOAuthState(userId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + TTL_MS;
  const payload = `${userId}.${nonce}.${exp}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/**
 * Valida o `state` do callback e devolve o userId embutido. Lança se a assinatura
 * não bater (comparação timing-safe) ou o token tiver expirado.
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
