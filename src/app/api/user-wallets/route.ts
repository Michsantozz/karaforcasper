import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/features/auth/model/session";
import {
  linkWallet,
  unlinkWallet,
  listWalletsByUser,
} from "@/server/casper/user-wallets";
import {
  assertSameOrigin,
  parseBody,
  publicKeyHexSchema,
  signatureHexSchema,
} from "@/shared/lib/http";

/** Lista as carteiras VERIFICADAS vinculadas ao usuário autenticado. */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const wallets = await listWalletsByUser(session.user.id);
  return NextResponse.json({
    wallets: wallets.map((w) => ({
      id: w.id,
      publicKeyHex: w.publicKeyHex,
      label: w.label,
      verifiedAt: w.verifiedAt,
      createdAt: w.createdAt,
    })),
  });
}

const linkSchema = z.object({
  publicKeyHex: publicKeyHexSchema,
  nonce: z.string().min(8).max(200),
  signatureHex: signatureHexSchema,
  label: z.string().max(100).optional(),
});

// Erros estáveis da lib → status HTTP.
const LINK_ERROR_STATUS: Record<string, number> = {
  invalid_public_key: 400,
  invalid_nonce: 400,
  nonce_already_used: 409,
  nonce_expired: 410,
  proof_failed: 403,
};

/**
 * Vincula uma carteira à conta COM PROVA DE POSSE. Exige nonce (de
 * /api/user-wallets/nonce) + a assinatura desse nonce pela carteira. A lib
 * verifica criptograficamente antes de gravar. Idempotente por (userId, pubkey).
 */
export async function POST(req: Request) {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { data, response } = await parseBody(req, linkSchema);
  if (response) return response;

  try {
    await linkWallet({
      userId: session.user.id,
      publicKeyHex: data.publicKeyHex,
      nonce: data.nonce,
      signatureHex: data.signatureHex,
      label: data.label ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: code },
      { status: LINK_ERROR_STATUS[code] ?? 400 },
    );
  }
}

const unlinkSchema = z.object({ publicKeyHex: publicKeyHexSchema });

/** Desvincula uma carteira. Body: { publicKeyHex }. */
export async function DELETE(req: Request) {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { data, response } = await parseBody(req, unlinkSchema);
  if (response) return response;

  await unlinkWallet(session.user.id, data.publicKeyHex);
  return NextResponse.json({ ok: true });
}
