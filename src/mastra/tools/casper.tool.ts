import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  transferCspr,
  getBalanceCspr,
} from "@/lib/casper/transfer";
import { getAgentPublicKeyHex } from "@/lib/casper/client";

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
export const transferCsprTool = createTool({
  id: "transfer_cspr",
  description:
    "Transfere CSPR da carteira do agente para um endereço alvo no Casper Testnet. Gera uma transação real on-chain. Use com cuidado — move fundos.",
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
