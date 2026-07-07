import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, isNotNull } from "drizzle-orm";
import { PublicKey } from "casper-js-sdk";
import { db } from "@/shared/db";
import {
  userWallets,
  walletLinkNonces,
  type UserWalletRow,
} from "@/shared/db/schema";
import { withAlgorithmTag } from "./user-sign";

/**
 * Carteiras Casper vinculadas a usuários do app.
 *
 * Serve dois propósitos no fluxo multisig:
 *  - resolver carteira → user, para notificar in-app os signatários que têm conta;
 *  - montar o dashboard "aguardando minha assinatura" (match por publicKeyHex).
 *
 * Vínculo exige PROVA DE POSSE (SIWE-style): o usuário assina um nonce com a
 * chave e o server verifica a assinatura antes de gravar. Sem isso, qualquer um
 * vincularia a pubkey alheia. publicKeyHex é sempre normalizada (lowercase).
 */

function norm(hex: string): string {
  return hex.trim().toLowerCase();
}

// ED25519: 01 + 64 hex (32 bytes). SECP256K1: 02 + 66 hex (33 bytes).
const VALID_PUBKEY = /^(?:01[0-9a-f]{64}|02[0-9a-f]{66})$/;
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 min

/** Valida o formato de uma public key Casper (ED25519 ou SECP256K1). */
export function isValidPublicKeyHex(hex: string): boolean {
  return VALID_PUBKEY.test(norm(hex));
}

/**
 * A Casper Wallet assina mensagens prefixando o header "Casper Message:\n".
 * Para verificar a assinatura de um nonce, reconstruímos a mesma mensagem.
 */
function casperMessageBytes(message: string): Uint8Array {
  return new TextEncoder().encode(`Casper Message:\n${message}`);
}

/**
 * Verifica criptograficamente que `signatureHex` foi produzida por
 * `publicKeyHex` sobre `message` (formato signMessage da Casper Wallet).
 * A assinatura da carteira é crua (64 bytes); o SDK espera a tag de algoritmo.
 */
export function verifyMessageSignature(args: {
  message: string;
  publicKeyHex: string;
  signatureHex: string;
}): boolean {
  try {
    const pub = PublicKey.fromHex(args.publicKeyHex);
    // verifySignature do SDK espera a assinatura COM a tag de algoritmo (65
    // bytes: 01/02 + 64 raw). A Casper Wallet devolve a assinatura crua (64
    // bytes), então withAlgorithmTag prefixa a tag conforme a curva da pubkey.
    const tagged = withAlgorithmTag(args.signatureHex, args.publicKeyHex);
    return pub.verifySignature(casperMessageBytes(args.message), tagged);
  } catch {
    return false;
  }
}

/**
 * Emite um nonce de uso único (5 min) para o usuário provar posse de uma
 * carteira. O client assina este nonce (signMessage) e devolve a assinatura.
 */
export async function createWalletLinkNonce(userId: string): Promise<string> {
  const nonce = `Vincular carteira ao CasperAgent — ${randomUUID()}`;
  await db.insert(walletLinkNonces).values({
    nonce,
    userId,
    expiresAt: new Date(Date.now() + NONCE_TTL_MS),
  });
  return nonce;
}

/**
 * Consome um nonce: valida que existe, pertence ao usuário, não expirou e não
 * foi usado. Marca como consumido. Lança em caso de violação.
 */
async function consumeNonce(nonce: string, userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(walletLinkNonces)
    .where(eq(walletLinkNonces.nonce, nonce))
    .limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) throw new Error("invalid_nonce");
  if (row.consumedAt) throw new Error("nonce_already_used");
  if (row.expiresAt.getTime() < Date.now()) throw new Error("nonce_expired");
  await db
    .update(walletLinkNonces)
    .set({ consumedAt: new Date() })
    .where(eq(walletLinkNonces.nonce, nonce));
}

/**
 * Vincula uma carteira a um usuário COM PROVA DE POSSE.
 *
 * Exige: o `nonce` emitido por createWalletLinkNonce + a `signatureHex` desse
 * nonce assinada pela carteira. Verifica criptograficamente (verifyMessageSignature)
 * que a assinatura corresponde à publicKey antes de gravar. Marca verifiedAt.
 * Idempotente por (userId, publicKeyHex). Lança em caso de prova inválida.
 */
export async function linkWallet(input: {
  userId: string;
  publicKeyHex: string;
  nonce: string;
  signatureHex: string;
  label?: string | null;
}): Promise<void> {
  if (!isValidPublicKeyHex(input.publicKeyHex)) {
    throw new Error("invalid_public_key");
  }
  // Consome o nonce (uso único, do próprio usuário, não expirado).
  await consumeNonce(input.nonce, input.userId);
  // Prova de posse: a assinatura do nonce tem que bater com a publicKey.
  const ok = verifyMessageSignature({
    message: input.nonce,
    publicKeyHex: input.publicKeyHex,
    signatureHex: input.signatureHex,
  });
  if (!ok) throw new Error("proof_failed");

  await db
    .insert(userWallets)
    .values({
      id: randomUUID(),
      userId: input.userId,
      publicKeyHex: norm(input.publicKeyHex),
      label: input.label ?? null,
      verifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userWallets.userId, userWallets.publicKeyHex],
      set: { label: input.label ?? null, verifiedAt: new Date() },
    });
}

/** Remove o vínculo de uma carteira de um usuário. */
export async function unlinkWallet(
  userId: string,
  publicKeyHex: string,
): Promise<void> {
  await db
    .delete(userWallets)
    .where(
      and(
        eq(userWallets.userId, userId),
        eq(userWallets.publicKeyHex, norm(publicKeyHex)),
      ),
    );
}

/** Carteiras VERIFICADAS vinculadas a um usuário. */
export async function listWalletsByUser(
  userId: string,
): Promise<UserWalletRow[]> {
  return db
    .select()
    .from(userWallets)
    .where(
      and(eq(userWallets.userId, userId), isNotNull(userWallets.verifiedAt)),
    );
}

/**
 * Resolve carteira → userId (vínculo VERIFICADO), ou null. Usado para notificar.
 * Só carteiras com posse provada contam.
 */
export async function resolveUserByWallet(
  publicKeyHex: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(userWallets)
    .where(
      and(
        eq(userWallets.publicKeyHex, norm(publicKeyHex)),
        isNotNull(userWallets.verifiedAt),
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Resolve um lote de carteiras → mapa publicKeyHex(normalizada) → userId. Só
 * inclui vínculos VERIFICADOS. Usado ao criar uma request para notificar de uma
 * vez todos os signatários que têm conta com posse provada.
 */
export async function resolveUsersByWallets(
  publicKeysHex: string[],
): Promise<Map<string, string>> {
  const keys = publicKeysHex.map(norm);
  if (keys.length === 0) return new Map();

  const rows = await db
    .select()
    .from(userWallets)
    .where(
      and(
        inArray(userWallets.publicKeyHex, keys),
        isNotNull(userWallets.verifiedAt),
      ),
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.publicKeyHex)) map.set(row.publicKeyHex, row.userId);
  }
  return map;
}

/** Sweep de nonces expirados/consumidos (housekeeping, chamado pelo cron). */
export async function sweepExpiredNonces(): Promise<void> {
  await db
    .delete(walletLinkNonces)
    .where(lt(walletLinkNonces.expiresAt, new Date()));
}
