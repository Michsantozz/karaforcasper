import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { balanceCspr, balanceMotes } from "@/server/casper/billing";
import { verifyAndCreditDeposit } from "@/server/casper/billing-deposit";
import { getAgentPublicKeyHex } from "@/server/casper/client";
import { withUserScope } from "@/shared/db/rls";

/**
 * Billing do usuário autenticado.
 *
 * GET  → saldo atual + endereço da conta do app (para onde depositar).
 * POST → { txHash } confirma um depósito on-chain e credita o ledger.
 *
 * O crédito é idempotente por txHash e só confia no que está on-chain (valor e
 * destino são lidos do nó, não do corpo da requisição).
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const userId = session.user.id;
  const [cspr, motes, depositAddress] = await Promise.all([
    withUserScope(userId, () => balanceCspr(userId)),
    withUserScope(userId, () => balanceMotes(userId)),
    getAgentPublicKeyHex(),
  ]);

  return NextResponse.json({
    balanceCspr: cspr,
    balanceMotes: motes.toString(),
    // Endereço da conta do app: o usuário transfere CSPR para cá para creditar.
    depositAddress,
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: { txHash?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  if (!txHash) {
    return NextResponse.json({ error: "txHash required" }, { status: 400 });
  }

  const userId = session.user.id;
  const { result, balance } = await withUserScope(userId, async () => {
    const result = await verifyAndCreditDeposit({ txHash, userId });
    return { result, balance: await balanceCspr(userId) };
  });

  if (!result.credited && result.reason !== "deposit already credited") {
    return NextResponse.json(
      { credited: false, reason: result.reason },
      { status: 422 },
    );
  }

  return NextResponse.json({
    credited: result.credited,
    reason: result.reason,
    amountCspr: result.amountCspr,
    balanceCspr: balance,
  });
}
