import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { prepareMultisigPayment } from "@/server/casper/multisig";
import {
  createSignatureRequest,
  getSignatureRequestState,
} from "@/server/casper/signature-request";
import {
  resolveUsersByWallets,
  listWalletsByUser,
} from "@/server/casper/user-wallets";
import { createNotificationsForUsers } from "@/server/casper/notifications";
import { listPendingForSigner } from "@/server/casper/signature-request";
import { emailSignatureRequested } from "@/server/email";
import { getSession } from "@/features/auth/model/session";

/**
 * Tools for the SaaS multisig flow (distributed signature collection).
 *
 * Unlike the in-memory multisig (meeting-chain.tool.ts), these persist the
 * request to the database and return a shareable /sign/:id LINK. Each signer
 * signs remotely from their own wallet; the quorum is recomputed server-side.
 * The tools resolve the session user server-side — they never trust a userId
 * coming from the chat.
 */

async function sessionUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error(
      "User not authenticated. Ask them to log in before creating the request.",
    );
  }
  return session.user.id;
}

const signerSchema = z.object({
  publicKeyHex: z.string(),
  label: z.string().optional(),
});

// Creates a persisted multisig request + shareable link. Replaces the
// "in-memory JSON" with the SaaS flow: persists, notifies signers who have an
// account, and returns /sign/:id to distribute.
export const prepareMultisigPaymentRequestTool = createTool({
  id: "prepare_multisig_payment_request",
  description:
    "Creates a PERSISTED multisig payment REQUEST and returns a shareable LINK (/sign/:id) for each signer to sign remotely from their own wallet. Use for payments that require several signatures collected over time (not in the same session). Provide the payer, destination, amount and the signers. Notifies in-app the signers who have an account. Returns the link + the initial state.",
  inputSchema: z.object({
    fromPublicKeyHex: z.string().describe("Payer wallet (where the CSPR comes from)"),
    toPublicKeyHex: z.string().describe("Payment recipient"),
    amountCspr: z
      .number()
      .min(2.5, "The network requires a minimum of 2.5 CSPR per transfer")
      .describe("Amount in CSPR (minimum 2.5 — network requirement)"),
    signers: z
      .array(signerSchema)
      .describe("Required signers: publicKeyHex + optional label"),
    threshold: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Quorum (number of signatures). Default: all signers"),
    description: z
      .string()
      .optional()
      .describe("Natural-language description of the payment"),
  }),
  outputSchema: z.object({
    id: z.string(),
    link: z.string(),
    status: z.string(),
    threshold: z.number(),
    requiredSigners: z.array(signerSchema),
    notified: z.number(),
    amountCspr: z.string(),
    to: z.string(),
    description: z.string().nullable(),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    // Builds the base tx (native transfer + signers), reusing the same builder.
    const signerKeys = input.signers.map((s) => s.publicKeyHex);
    const state = prepareMultisigPayment({
      fromPublicKeyHex: input.fromPublicKeyHex,
      toPublicKeyHex: input.toPublicKeyHex,
      amountCspr: input.amountCspr,
      signerPublicKeysHex: signerKeys,
      threshold: input.threshold,
    });

    // Persists as a signature_request. The required signers come from the
    // state (includes the payer), preserving provided labels when they match.
    const labelByKey = new Map(
      input.signers.map((s) => [s.publicKeyHex.toLowerCase(), s.label]),
    );
    const requiredSigners = state.signers.map((k) => ({
      publicKeyHex: k,
      label: labelByKey.get(k),
    }));

    const request = await createSignatureRequest({
      createdByUserId: userId,
      kind: "payment",
      description:
        input.description ??
        `Payment of ${input.amountCspr} CSPR to ${input.toPublicKeyHex.slice(0, 10)}…`,
      transactionJson: state.transactionJson,
      requiredSigners,
      threshold: state.threshold,
      chainName: state.chainName,
    });

    // Notifies signers who have an account (except the creator).
    const walletToUser = await resolveUsersByWallets(
      requiredSigners.map((s) => s.publicKeyHex),
    );
    const targets = Array.from(walletToUser.values()).filter(
      (uid) => uid !== userId,
    );
    await createNotificationsForUsers({
      userIds: targets,
      type: "signature_requested",
      message: request.description
        ? `Signature requested: ${request.description}`
        : "There is a transaction waiting for your signature.",
      requestId: request.id,
    });

    // External push (email) in addition to the in-app bell — reaches the
    // signer even if they're logged out. Best-effort: emailSignatureRequested never throws.
    await Promise.all(
      targets.map((uid) =>
        emailSignatureRequested({
          userId: uid,
          requestId: request.id,
          description: request.description,
        }),
      ),
    );

    return {
      id: request.id,
      link: `/sign/${request.id}`,
      status: request.status,
      threshold: request.threshold,
      requiredSigners,
      notified: targets.length,
      amountCspr: String(input.amountCspr),
      to: input.toPublicKeyHex,
      description: request.description ?? null,
    };
  },
});

// Leitura do estado de uma solicitação (progresso de assinaturas).
export const getSignatureRequestTool = createTool({
  id: "get_signature_request",
  description:
    "Consulta o estado de uma solicitação multisig pelo id: progresso (quem assinou / quem falta), quórum e status. Use para acompanhar uma coleta de assinaturas em andamento.",
  inputSchema: z.object({
    id: z.string().describe("ID da solicitação (slug do link /sign/:id)"),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.string(),
    description: z.string().nullable(),
    threshold: z.number(),
    signed: z.array(z.string()),
    pending: z.array(z.string()),
    ready: z.boolean(),
    link: z.string(),
    transactionHash: z.string().nullable(),
  }),
  execute: async (input) => {
    const state = await getSignatureRequestState(input.id);
    if (!state) throw new Error("Solicitação não encontrada.");
    return {
      id: state.request.id,
      status: state.request.status,
      description: state.request.description,
      threshold: state.request.threshold,
      signed: state.signed,
      pending: state.pending,
      ready: state.ready,
      link: `/sign/${state.request.id}`,
      transactionHash: state.request.transactionHash,
    };
  },
});

// "Aguardando minha assinatura" — match das carteiras do usuário da sessão.
export const listMyPendingSignaturesTool = createTool({
  id: "list_my_pending_signatures",
  description:
    "Lista as solicitações multisig que aguardam a assinatura do usuário atual (match pelas carteiras vinculadas à conta). Use quando o usuário perguntar 'o que preciso assinar?'. Retorna cada uma com o link /sign/:id.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    pending: z.array(
      z.object({
        id: z.string(),
        description: z.string().nullable(),
        status: z.string(),
        signedCount: z.number(),
        threshold: z.number(),
        link: z.string(),
      }),
    ),
  }),
  execute: async () => {
    const userId = await sessionUserId();
    const wallets = await listWalletsByUser(userId);
    const states = await listPendingForSigner(
      wallets.map((w) => w.publicKeyHex),
    );
    return {
      pending: states.map((s) => ({
        id: s.request.id,
        description: s.request.description,
        status: s.request.status,
        signedCount: s.signed.length,
        threshold: s.request.threshold,
        link: `/sign/${s.request.id}`,
      })),
    };
  },
});
