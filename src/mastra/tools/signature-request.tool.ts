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
 * Tools do fluxo multisig SaaS (coleta distribuída de assinaturas).
 *
 * Diferente do multisig em memória (meeting-chain.tool.ts), estas persistem a
 * solicitação no banco e devolvem um LINK compartilhável /sign/:id. Cada
 * signatário assina remoto pela própria carteira; o quórum é recalculado no
 * servidor. As tools resolvem o usuário da sessão server-side — nunca confiam
 * num userId vindo do chat.
 */

async function sessionUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error(
      "Usuário não autenticado. Peça para fazer login antes de criar a solicitação.",
    );
  }
  return session.user.id;
}

const signerSchema = z.object({
  publicKeyHex: z.string(),
  label: z.string().optional(),
});

// Cria uma solicitação multisig persistida + link compartilhável. Substitui o
// "JSON em memória" pelo fluxo SaaS: persiste, notifica signatários com conta e
// devolve /sign/:id para distribuir.
export const prepareMultisigPaymentRequestTool = createTool({
  id: "prepare_multisig_payment_request",
  description:
    "Cria uma SOLICITAÇÃO de pagamento multisig PERSISTIDA e devolve um LINK compartilhável (/sign/:id) para cada signatário assinar remoto pela própria carteira. Use para pagamentos que exigem várias assinaturas coletadas ao longo do tempo (não na mesma sessão). Informe pagadora, destino, valor e os signatários. Notifica in-app os signatários que têm conta. Retorna o link + o estado inicial.",
  inputSchema: z.object({
    fromPublicKeyHex: z.string().describe("Carteira pagadora (de onde sai o CSPR)"),
    toPublicKeyHex: z.string().describe("Destinatário do pagamento"),
    amountCspr: z
      .number()
      .min(2.5, "A rede exige no mínimo 2.5 CSPR por transferência")
      .describe("Valor em CSPR (mínimo 2.5 — exigência da rede)"),
    signers: z
      .array(signerSchema)
      .describe("Signatários exigidos: publicKeyHex + label opcional"),
    threshold: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Quórum (nº de assinaturas). Padrão: todos os signatários"),
    description: z
      .string()
      .optional()
      .describe("Descrição em linguagem natural do pagamento"),
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

    // Monta a tx base (transfer nativo + signatários), reusando o mesmo builder.
    const signerKeys = input.signers.map((s) => s.publicKeyHex);
    const state = prepareMultisigPayment({
      fromPublicKeyHex: input.fromPublicKeyHex,
      toPublicKeyHex: input.toPublicKeyHex,
      amountCspr: input.amountCspr,
      signerPublicKeysHex: signerKeys,
      threshold: input.threshold,
    });

    // Persiste como signature_request. Os signatários exigidos saem do state
    // (inclui a pagadora), preservando labels informados quando coincidem.
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
        `Pagamento de ${input.amountCspr} CSPR para ${input.toPublicKeyHex.slice(0, 10)}…`,
      transactionJson: state.transactionJson,
      requiredSigners,
      threshold: state.threshold,
      chainName: state.chainName,
    });

    // Notifica signatários com conta (exceto o criador).
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
        ? `Assinatura solicitada: ${request.description}`
        : "Há uma transação aguardando sua assinatura.",
      requestId: request.id,
    });

    // Push externo (e-mail) além do sino in-app — alcança o signatário deslogado.
    // Best-effort: emailSignatureRequested nunca lança.
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
