import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  transferCspr,
  getBalanceCspr,
} from "@/server/casper/transfer";
import { getAgentPublicKeyHex } from "@/server/casper/client";
import {
  prepareUserTransfer,
  prepareUserDelegate,
  prepareUserUndelegate,
  broadcastUserSignedTransfer,
} from "@/server/casper/user-sign";
import { putTx, getTx } from "@/server/casper/tx-store";

// Tool: saldo do agente. Read-only.
export const getAgentWalletTool = createTool({
  id: "get_agent_wallet",
  description:
    "Retorna a public key (endereço) e o saldo em CSPR da carteira do agente no Casper Testnet.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    publicKey: z.string(),
    balanceCspr: z.string(),
  }),
  execute: async () => {
    const publicKey = await getAgentPublicKeyHex();
    const balanceCspr = await getBalanceCspr(publicKey);
    return { publicKey, balanceCspr };
  },
});

// Tool: consulta saldo de qualquer endereço. Read-only.
export const getBalanceTool = createTool({
  id: "get_balance",
  description: "Consulta o saldo em CSPR de uma public key no Casper Testnet.",
  inputSchema: z.object({
    publicKeyHex: z.string().describe("Public key alvo em hex"),
  }),
  outputSchema: z.object({ balanceCspr: z.string() }),
  execute: async (input) => {
    const balanceCspr = await getBalanceCspr(input.publicKeyHex);
    return { balanceCspr };
  },
});

// Tool: transfere CSPR — ESCREVE on-chain (gera transação no Testnet).
// Move fundos da carteira do AGENTE → requireApproval (human-in-the-loop) como
// 4ª camada de defesa. As 3 primeiras (teto/allowlist/fail-closed) vivem em
// assertTransferAllowed e valem mesmo se a aprovação for burlada no handler.
export const transferCsprTool = createTool({
  id: "transfer_cspr",
  description:
    "Transfere CSPR da carteira do agente para um endereço alvo no Casper Testnet. Gera uma transação real on-chain. Use com cuidado — move fundos.",
  requireApproval: true,
  inputSchema: z.object({
    toPublicKeyHex: z.string().describe("Public key do destinatário em hex"),
    amountCspr: z.number().positive().describe("Quantidade em CSPR"),
  }),
  outputSchema: z.object({
    transactionHash: z.string(),
    amountCspr: z.string(),
    to: z.string(),
    chainName: z.string(),
    explorerUrl: z.string(),
  }),
  execute: async (input) => {
    const res = await transferCspr({
      toPublicKeyHex: input.toPublicKeyHex,
      amountCspr: input.amountCspr,
    });
    return {
      ...res,
      explorerUrl: `https://testnet.cspr.live/deploy/${res.transactionHash}`,
    };
  },
});

// Tool: monta um transfer a partir da carteira do USUÁRIO (não a do agente),
// SEM assinar. Devolve o JSON da tx p/ ser assinado pela Casper Wallet no
// browser (via a frontend tool sign_with_wallet). Não toca a rede.
export const prepareUserTransferTool = createTool({
  id: "prepare_user_transfer",
  description:
    "Monta (sem assinar) um transfer de CSPR a partir da carteira CONECTADA DO USUÁRIO. Use quando o usuário pedir para enviar fundos da própria carteira (não a do agente). Requer que a carteira já esteja conectada (use connect_wallet antes para obter o endereço). Retorna um txId para sign_with_wallet (txId) e broadcast_signed_tx (txId).",
  inputSchema: z.object({
    fromPublicKeyHex: z
      .string()
      .describe("Public key (hex) da conta ativa conectada do usuário"),
    toPublicKeyHex: z.string().describe("Public key do destinatário em hex"),
    amountCspr: z.number().positive().describe("Quantidade em CSPR"),
  }),
  outputSchema: z.object({
    txId: z.string(),
    signerPublicKeyHex: z.string(),
    amountCspr: z.string(),
    to: z.string(),
    chainName: z.string(),
  }),
  execute: async (input) => {
    const r = prepareUserTransfer({
      fromPublicKeyHex: input.fromPublicKeyHex,
      toPublicKeyHex: input.toPublicKeyHex,
      amountCspr: input.amountCspr,
    });
    const { transactionJson, ...rest } = r;
    return {
      ...rest,
      txId: putTx(transactionJson, {
        kind: "transfer",
        amountCspr: rest.amountCspr,
        from: input.fromPublicKeyHex,
        to: rest.to,
      }),
    };
  },
});

// Tool: monta (sem assinar) uma DELEGAÇÃO de CSPR da carteira do usuário a um
// validador (staking). Devolve o JSON p/ sign_with_wallet → broadcast_signed_tx.
export const prepareUserDelegateTool = createTool({
  id: "prepare_user_delegate",
  description:
    "Monta (sem assinar) uma delegação (staking) de CSPR da carteira CONECTADA DO USUÁRIO para um validador. Staking gera recompensas. Requer carteira conectada (use connect_wallet antes). Retorna o JSON para ser assinado pela extensão. Depois use sign_with_wallet e broadcast_signed_tx.",
  inputSchema: z.object({
    fromPublicKeyHex: z
      .string()
      .describe("Public key (hex) da conta ativa conectada do usuário"),
    validatorPublicKeyHex: z
      .string()
      .describe("Public key (hex) do validador alvo"),
    amountCspr: z.number().positive().describe("Quantidade a delegar em CSPR"),
  }),
  outputSchema: z.object({
    txId: z.string(),
    signerPublicKeyHex: z.string(),
    amountCspr: z.string(),
    validator: z.string(),
    chainName: z.string(),
  }),
  execute: async (input) => {
    const { transactionJson, ...rest } = prepareUserDelegate({
      fromPublicKeyHex: input.fromPublicKeyHex,
      validatorPublicKeyHex: input.validatorPublicKeyHex,
      amountCspr: input.amountCspr,
    });
    return {
      ...rest,
      txId: putTx(transactionJson, {
        kind: "delegate",
        amountCspr: rest.amountCspr,
        from: input.fromPublicKeyHex,
        to: rest.validator,
      }),
    };
  },
});

// Tool: monta (sem assinar) o RESGATE (undelegate) de CSPR stakeado da carteira
// do usuário. Devolve o JSON p/ sign_with_wallet → broadcast_signed_tx.
export const prepareUserUndelegateTool = createTool({
  id: "prepare_user_undelegate",
  description:
    "Monta (sem assinar) o resgate (undelegate) de CSPR previamente stakeado pela carteira CONECTADA DO USUÁRIO em um validador. Requer carteira conectada. Retorna o JSON para ser assinado pela extensão. Depois use sign_with_wallet e broadcast_signed_tx.",
  inputSchema: z.object({
    fromPublicKeyHex: z
      .string()
      .describe("Public key (hex) da conta ativa conectada do usuário"),
    validatorPublicKeyHex: z
      .string()
      .describe("Public key (hex) do validador de onde resgatar"),
    amountCspr: z.number().positive().describe("Quantidade a resgatar em CSPR"),
  }),
  outputSchema: z.object({
    txId: z.string(),
    signerPublicKeyHex: z.string(),
    amountCspr: z.string(),
    validator: z.string(),
    chainName: z.string(),
  }),
  execute: async (input) => {
    const { transactionJson, ...rest } = prepareUserUndelegate({
      fromPublicKeyHex: input.fromPublicKeyHex,
      validatorPublicKeyHex: input.validatorPublicKeyHex,
      amountCspr: input.amountCspr,
    });
    return {
      ...rest,
      txId: putTx(transactionJson, {
        kind: "undelegate",
        amountCspr: rest.amountCspr,
        from: input.fromPublicKeyHex,
        to: rest.validator,
      }),
    };
  },
});

// Tool: recebe a tx assinada pela carteira do usuário (JSON + signatureHex) e
// submete on-chain. ESCREVE na rede. Chamada pelo agente após sign_with_wallet.
export const broadcastSignedTxTool = createTool({
  id: "broadcast_signed_tx",
  description:
    "Submete on-chain uma transação assinada pela carteira do usuário. Passe txId (de prepare_user_*/setup) OU transactionJson, a signatureHex (de sign_with_wallet) e o signerPublicKeyHex. Gera transação real no Testnet.",
  inputSchema: z.object({
    txId: z
      .string()
      .optional()
      .describe("ID curto da tx no store (preferido). Use o mesmo txId que assinou."),
    transactionJson: z
      .string()
      .optional()
      .describe("JSON da tx (fallback se não houver txId)"),
    signatureHex: z.string().describe("Assinatura hex de sign_with_wallet"),
    signerPublicKeyHex: z
      .string()
      .describe("Public key (hex) que assinou — a conta do usuário"),
  }),
  outputSchema: z.object({
    transactionHash: z.string(),
    explorerUrl: z.string(),
  }),
  execute: async (input) => {
    const json = input.txId ? getTx(input.txId) : input.transactionJson;
    if (!json)
      throw new Error(
        "Transação não encontrada: forneça txId válido (não expirado) ou transactionJson.",
      );
    return broadcastUserSignedTransfer({
      transactionJson: json,
      signatureHex: input.signatureHex,
      signerPublicKeyHex: input.signerPublicKeyHex,
    });
  },
});
