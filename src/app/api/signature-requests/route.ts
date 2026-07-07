import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/features/auth/model/session";
import {
  createSignatureRequest,
  listRequestsByCreator,
  partitionSignerNotifications,
} from "@/server/casper/signature-request";
import { resolveUsersByWallets } from "@/server/casper/user-wallets";
import { createNotificationsForUsers } from "@/server/casper/notifications";
import {
  emailSignatureRequested,
  emailExternalSignatureRequested,
} from "@/server/email";
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
        // Optional: invite an external signer (no linked wallet) by email.
        email: z.string().email().max(200).optional(),
      }),
    )
    .min(1)
    .max(20),
  threshold: z.number().int().min(1),
  chainName: z.string().max(50).optional(),
});

// Stable lib errors (tx validation) → HTTP status.
const CREATE_ERROR_STATUS: Record<string, number> = {
  transaction_too_large: 413,
  invalid_transaction_json: 422,
  transfer_below_minimum: 422,
};

/**
 * Creates a multisig signature request (auth). Receives the base tx + the
 * required signers + the quorum. On creation, notifies in-app each signer that
 * has a linked account (resolves wallet → user).
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

  // Resolve linked wallets → users, then partition who gets notified (no
  // overlap between account signers and external email invites). The dedup rule
  // lives in the pure partitionSignerNotifications (unit-tested).
  const walletToUser = await resolveUsersByWallets(
    request.requiredSigners.map((s) => s.publicKeyHex),
  );
  const { accountUserIds, externalEmails } = partitionSignerNotifications({
    requiredSigners: request.requiredSigners,
    walletToUser,
    createdByUserId: session.user.id,
  });

  await createNotificationsForUsers({
    userIds: accountUserIds,
    type: "signature_requested",
    message: request.description
      ? `Signature requested: ${request.description}`
      : "There is a transaction awaiting your signature.",
    requestId: request.id,
  });

  // External push: email with a direct link to /sign/{id}. Reaches the signer
  // even when logged out, complementing the in-app bell. Best-effort — sendEmail
  // never throws (degrades to a no-op without RESEND_API_KEY), so creation
  // doesn't fail if the email fails. Fired in parallel; we await all before
  // responding.
  await Promise.all([
    ...accountUserIds.map((userId) =>
      emailSignatureRequested({
        userId,
        requestId: request.id,
        description: request.description,
      }),
    ),
    ...externalEmails.map((to) =>
      emailExternalSignatureRequested({
        to,
        requestId: request.id,
        description: request.description,
      }),
    ),
  ]);

  return NextResponse.json({
    id: request.id,
    status: request.status,
    link: `/sign/${request.id}`,
    notified: accountUserIds.length,
    invitedExternal: externalEmails.length,
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
 * Lists the requests created by the authenticated user. Supports filtering by
 * status (?status=pending,ready) and pagination (?limit=&offset=) for history.
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
