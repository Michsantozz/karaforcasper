import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/features/auth/model/session";
import {
  createSignatureRequest,
  listRequestsByCreator,
} from "@/server/casper/signature-request";
import { resolveUsersByWallets } from "@/server/casper/user-wallets";
import { createNotificationsForUsers } from "@/server/casper/notifications";
import { assertSameOrigin, parseBody, publicKeyHexSchema } from "@/shared/lib/http";
import type { SignatureRequestStatus } from "@/shared/db/schema";

const createSchema = z.object({
  kind: z.enum(["payment", "setup"]).default("payment"),
  description: z.string().max(500).optional(),
  transactionJson: z.string().min(1).max(64_000),
  requiredSigners: z
    .array(
      z.object({
        publicKeyHex: publicKeyHexSchema,
        label: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(20),
  threshold: z.number().int().min(1),
  chainName: z.string().max(50).optional(),
});

// Erros estáveis da lib (validação de tx) → status HTTP.
const CREATE_ERROR_STATUS: Record<string, number> = {
  transaction_too_large: 413,
  invalid_transaction_json: 422,
  transfer_below_minimum: 422,
};

/**
 * Cria uma solicitação de assinatura multisig (auth). Recebe a tx base + os
 * signatários exigidos + o quórum. Ao criar, notifica in-app cada signatário que
 * tem conta vinculada (resolve carteira → user).
 */
export async function POST(req: Request) {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { data: body, response } = await parseBody(req, createSchema);
  if (response) return response;

  let request;
  try {
    request = await createSignatureRequest({
      createdByUserId: session.user.id,
      kind: body.kind,
      description: body.description ?? null,
      transactionJson: body.transactionJson,
      requiredSigners: body.requiredSigners,
      threshold: body.threshold,
      chainName: body.chainName,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: code },
      { status: CREATE_ERROR_STATUS[code] ?? 400 },
    );
  }

  // Notifica signatários que têm conta (exceto o próprio criador).
  const walletToUser = await resolveUsersByWallets(
    request.requiredSigners.map((s) => s.publicKeyHex),
  );
  const targets = Array.from(walletToUser.values()).filter(
    (uid) => uid !== session.user.id,
  );
  await createNotificationsForUsers({
    userIds: targets,
    type: "signature_requested",
    message: request.description
      ? `Assinatura solicitada: ${request.description}`
      : "Há uma transação aguardando sua assinatura.",
    requestId: request.id,
  });

  return NextResponse.json({
    id: request.id,
    status: request.status,
    link: `/sign/${request.id}`,
    notified: targets.length,
  });
}

const VALID_STATUS: SignatureRequestStatus[] = [
  "pending",
  "ready",
  "broadcast",
  "confirmed",
  "expired",
  "cancelled",
];

/**
 * Lista as solicitações criadas pelo usuário autenticado. Suporta filtro por
 * status (?status=pending,ready) e paginação (?limit=&offset=) para o histórico.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam
    ? (statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is SignatureRequestStatus =>
          VALID_STATUS.includes(s as SignatureRequestStatus),
        ) as SignatureRequestStatus[])
    : undefined;
  const limit = Number(url.searchParams.get("limit")) || undefined;
  const offset = Number(url.searchParams.get("offset")) || undefined;

  const requests = await listRequestsByCreator(session.user.id, {
    status: status && status.length > 0 ? status : undefined,
    limit,
    offset,
  });
  return NextResponse.json({
    requests: requests.map((r) => ({
      id: r.id,
      kind: r.kind,
      description: r.description,
      status: r.status,
      threshold: r.threshold,
      requiredSigners: r.requiredSigners,
      transactionHash: r.transactionHash,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    })),
  });
}
