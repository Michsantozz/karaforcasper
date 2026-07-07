import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  notarizeMeeting,
  verifyMeeting,
  type MeetingRecord,
} from "@/server/casper/meeting-notary";
import {
  prepareMultisigPayment,
  addMultisigApproval,
  broadcastMultisig,
} from "@/server/casper/multisig";
import { prepareMultisigSetup } from "@/server/casper/multisig-setup";

// Schema da ata reutilizado pelas tools de notarização.
const meetingRecordSchema = z.object({
  botId: z.string(),
  summary: z.string().nullable(),
  decisions: z.array(z.string()).optional(),
  actionItems: z
    .array(z.object({ task: z.string(), owner: z.string().nullable() }))
    .optional(),
  participants: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
});

// --- Mock para testes E2E (sem reunião real do Recall) ------------------

// Atas de exemplo, identificadas por um "demo id" amigável. Permitem testar o
// fluxo completo (ata → notarize → verify) sem precisar de um bot/transcrição
// reais do Recall.ai. NÃO usar em produção.
const DEMO_MEETINGS: Record<string, z.infer<typeof meetingRecordSchema>> = {
  "demo-q3": {
    botId: "demo-q3",
    summary:
      "Reunião de planejamento do Q3. O time alinhou prioridades de produto, aprovou o orçamento de marketing e definiu responsáveis pelas próximas entregas.",
    decisions: [
      "Aprovar o orçamento de marketing de R$ 50 mil para o Q3",
      "Lançar a nova feature de notarização em julho",
    ],
    actionItems: [
      { task: "Contratar um designer de produto", owner: "Ana" },
      { task: "Fechar contrato com o fornecedor de infraestrutura", owner: "Bruno" },
      { task: "Preparar a demo para o buildathon", owner: "Carla" },
    ],
    participants: ["Ana", "Bruno", "Carla"],
    topics: ["orçamento", "roadmap Q3", "contratações", "buildathon"],
  },
  "demo-pagamento": {
    botId: "demo-pagamento",
    summary:
      "Reunião do comitê financeiro. Decidido um pagamento que exige aprovação de múltiplos signatários antes de ser executado.",
    decisions: ["Pagar 5 CSPR ao fornecedor, com aprovação de 2 dos 2 signatários"],
    actionItems: [
      { task: "Executar pagamento multisig de 5 CSPR ao fornecedor", owner: "Ana" },
    ],
    participants: ["Ana", "Bruno"],
    topics: ["pagamento", "multisig", "fornecedor"],
  },
};

const DEFAULT_DEMO = DEMO_MEETINGS["demo-q3"]!;

export const getMockMeetingTool = createTool({
  id: "get_mock_meeting",
  description:
    "Retorna uma ata de reunião de EXEMPLO (mock) para testes, sem precisar de um bot real do Recall.ai. demoId disponíveis: 'demo-q3' (planejamento) e 'demo-pagamento' (comitê financeiro com action item de pagamento). Use o resultado como entrada para notarize_meeting ou para montar um multisig.",
  inputSchema: z.object({
    demoId: z
      .enum(["demo-q3", "demo-pagamento"])
      .default("demo-q3")
      .describe("Qual ata de exemplo retornar"),
  }),
  outputSchema: meetingRecordSchema,
  execute: async (input) =>
    (input.demoId ? DEMO_MEETINGS[input.demoId] : undefined) ?? DEFAULT_DEMO,
});

// --- Notarização (Proof-of-Meeting) -------------------------------------

// Ancora o hash da ata on-chain. Assina com a carteira DO AGENTE (server-side),
// gera transação real imediatamente — sem popup.
export const notarizeMeetingTool = createTool({
  id: "notarize_meeting",
  description:
    "Ancora (notariza) o hash da ata de uma reunião on-chain no Casper, gerando uma prova imutável (proof-of-meeting). Use depois de summarize_meeting/get_participants: passe o resumo, decisões, action items e participantes. Assina com a carteira do agente — não precisa do usuário. Retorna o hash da ata e o transactionHash.",
  inputSchema: z.object({
    record: meetingRecordSchema.describe(
      "A ata: resultado de summarize_meeting + participantes de get_participants",
    ),
  }),
  outputSchema: z.object({
    meetingHash: z.string(),
    transactionHash: z.string(),
    notary: z.string(),
    chainName: z.string(),
    explorerUrl: z.string(),
  }),
  execute: async (input) => notarizeMeeting(input.record as MeetingRecord),
});

// Verifica uma notarização: lê on-chain e (se a ata for fornecida) confere se
// o hash bate.
export const verifyMeetingTool = createTool({
  id: "verify_meeting",
  description:
    "Verifica uma notarização de reunião: lê a transação on-chain pelo transactionHash, extrai o hash ancorado e, se a ata for fornecida, recalcula e compara — provando que a ata corresponde ao registro on-chain.",
  inputSchema: z.object({
    transactionHash: z.string().describe("Hash da tx de notarização"),
    record: meetingRecordSchema
      .optional()
      .describe("Ata a conferir contra o hash on-chain (opcional)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    anchoredId: z.number().nullable(),
    expectedId: z.number().nullable(),
    recomputedHash: z.string().nullable(),
    matches: z.boolean(),
    transactionHash: z.string(),
    explorerUrl: z.string(),
  }),
  execute: async (input) =>
    verifyMeeting({
      transactionHash: input.transactionHash,
      record: input.record as MeetingRecord | undefined,
    }),
});

// --- Multisig de pagamento (action item financeiro) ---------------------

const multisigStateSchema = z.object({
  transactionJson: z.string(),
  from: z.string(),
  to: z.string(),
  amountCspr: z.string(),
  signers: z.array(z.string()),
  threshold: z.number(),
  signed: z.array(z.string()),
  pending: z.array(z.string()),
  ready: z.boolean(),
  chainName: z.string(),
});

// Configura a conta como MULTISIG NATIVA (rede impõe o quórum). Gera os deploys
// de session wasm (add_account + update_thresholds) que a conta primária assina.
export const setupMultisigAccountTool = createTool({
  id: "setup_multisig_account",
  description:
    "Configura uma conta como MULTISIG NATIVA do Casper: adiciona signatários (associated keys com peso) e define o quórum (thresholds). A partir daí a REDE exige o quórum — diferente do multisig demonstrável. Retorna uma sequência de passos (steps): cada step.transactionJson deve ser assinado pela conta PRIMÁRIA via sign_with_wallet e submetido com broadcast_signed_tx, NA ORDEM. Atenção: o key_management_threshold não pode exceder a soma de pesos controlável pela conta primária, ou a conta trava.",
  inputSchema: z.object({
    primaryPublicKeyHex: z
      .string()
      .describe("Conta primária (dona) — a que será configurada e assina os setups"),
    associates: z
      .array(
        z.object({
          publicKeyHex: z.string(),
          weight: z.number().int().positive(),
        }),
      )
      .describe("Signatários a adicionar como associated keys, com peso"),
    deploymentThreshold: z
      .number()
      .int()
      .positive()
      .describe("Soma de pesos exigida para enviar transações"),
    keyManagementThreshold: z
      .number()
      .int()
      .positive()
      .describe("Soma de pesos exigida para gerenciar as chaves da conta"),
    primaryWeight: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Peso da chave primária (deve ser >= keyManagementThreshold para não travar a conta). Padrão: keyManagementThreshold.",
      ),
  }),
  outputSchema: z.object({
    primaryPublicKeyHex: z.string(),
    steps: z.array(z.object({ label: z.string(), txId: z.string() })),
    config: z.object({
      primaryWeight: z.number(),
      associatedKeys: z.array(
        z.object({ publicKeyHex: z.string(), weight: z.number() }),
      ),
      deploymentThreshold: z.number(),
      keyManagementThreshold: z.number(),
    }),
    chainName: z.string(),
  }),
  execute: async (input) =>
    prepareMultisigSetup({
      primaryPublicKeyHex: input.primaryPublicKeyHex,
      associates: input.associates,
      deploymentThreshold: input.deploymentThreshold,
      keyManagementThreshold: input.keyManagementThreshold,
      primaryWeight: input.primaryWeight,
    }),
});

// Monta um pagamento que exige múltiplas assinaturas (ex.: action item
// "pagar X" decidido em reunião). Não assina nem envia.
export const prepareMultisigPaymentTool = createTool({
  id: "prepare_multisig_payment",
  description:
    "Monta um pagamento de CSPR que exige a assinatura de VÁRIOS signatários (multisig) antes de ser submetido — ex.: um action item financeiro decidido em reunião. Informe a carteira pagadora, o destino, o valor e as public keys de todos os signatários. Retorna o estado multisig (quem precisa assinar). Depois, para cada signatário: sign_with_wallet → add_signature; quando ready=true, broadcast_multisig.",
  inputSchema: z.object({
    fromPublicKeyHex: z.string().describe("Carteira pagadora (de onde sai o CSPR)"),
    toPublicKeyHex: z.string().describe("Destinatário do pagamento"),
    amountCspr: z.number().positive().describe("Valor em CSPR"),
    signerPublicKeysHex: z
      .array(z.string())
      .describe("Public keys de TODOS os signatários exigidos"),
    threshold: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Quórum (nº de assinaturas). Padrão: todos os signatários"),
  }),
  outputSchema: multisigStateSchema,
  execute: async (input) =>
    prepareMultisigPayment({
      fromPublicKeyHex: input.fromPublicKeyHex,
      toPublicKeyHex: input.toPublicKeyHex,
      amountCspr: input.amountCspr,
      signerPublicKeysHex: input.signerPublicKeysHex,
      threshold: input.threshold,
    }),
});

// Anexa uma assinatura (de sign_with_wallet) à tx multisig.
export const addSignatureTool = createTool({
  id: "add_signature",
  description:
    "Anexa UMA assinatura à transação multisig (de prepare_multisig_payment) após um signatário assinar com sign_with_wallet. Passe o estado multisig atual e a signatureHex + signerPublicKeyHex. Retorna o estado atualizado; quando ready=true, chame broadcast_multisig.",
  inputSchema: z.object({
    state: multisigStateSchema.describe("Estado multisig atual"),
    signatureHex: z.string().describe("Assinatura de sign_with_wallet"),
    signerPublicKeyHex: z.string().describe("Quem assinou (public key hex)"),
  }),
  outputSchema: multisigStateSchema,
  execute: async (input) =>
    addMultisigApproval({
      transactionJson: input.state.transactionJson,
      signatureHex: input.signatureHex,
      signerPublicKeyHex: input.signerPublicKeyHex,
      meta: {
        from: input.state.from,
        to: input.state.to,
        amountCspr: input.state.amountCspr,
        signers: input.state.signers,
        threshold: input.state.threshold,
      },
    }),
});

// Submete a tx multisig quando o quórum foi atingido.
export const broadcastMultisigTool = createTool({
  id: "broadcast_multisig",
  description:
    "Submete on-chain a transação multisig quando o quórum de assinaturas foi atingido (state.ready === true). Passe state.transactionJson. Gera transação real no Testnet.",
  inputSchema: z.object({
    transactionJson: z.string().describe("transactionJson do estado multisig"),
    amountCspr: z
      .string()
      .optional()
      .describe("valor (state.amountCspr) — só para exibir no card de confirmação"),
    to: z
      .string()
      .optional()
      .describe("destinatário (state.to) — só para exibir no card de confirmação"),
  }),
  outputSchema: z.object({
    transactionHash: z.string(),
    explorerUrl: z.string(),
    amountCspr: z.string().optional(),
    to: z.string().optional(),
  }),
  execute: async (input) => {
    const out = await broadcastMultisig(input.transactionJson);
    return { ...out, amountCspr: input.amountCspr, to: input.to };
  },
});
