import { MCPClient } from "@mastra/mcp";

/**
 * MCP client conectando o agente aos servidores MCP do ecossistema Casper.
 *
 * - csprTrade: DEX (swaps, cotações, liquidez, portfolio). Público, sem API key.
 * - csprCloud: queries de blockchain (saldo, blocos, deploys, NFT, staking).
 *   Exige CSPR_CLOUD_API_KEY — só é registrado quando a key está presente.
 * - recall: read-only do Recall.ai (bots, recordings, calendar, docs).
 *   Exige RECALL_API_KEY. A escrita (criar/agendar/controlar bot) NÃO vem do MCP
 *   — está em src/mastra/tools/recall.tool.ts (REST). Aqui é só leitura.
 *
 * Consumido no agente via `tools: async () => mcp.listTools()` (DynamicArgument),
 * o padrão canônico: resolve por request, sem top-level await no boot.
 */
const csprCloudApiKey = process.env.CSPR_CLOUD_API_KEY;
const recallApiKey = process.env.RECALL_API_KEY;
const recallRegion = process.env.RECALL_REGION || "us-east-1";

export const mcp = new MCPClient({
  id: "casper-mcp",
  timeout: 30000,
  servers: {
    csprTrade: {
      url: new URL("https://mcp.cspr.trade/mcp"),
    },
    // CSPR.cloud testnet — registrado apenas com a API key configurada.
    ...(csprCloudApiKey
      ? {
          csprCloud: {
            url: new URL("https://mcp.testnet.cspr.cloud/mcp"),
            requestInit: {
              headers: { "X-CSPR-Cloud-Api-Key": csprCloudApiKey },
            },
          },
        }
      : {}),
    // Recall.ai (read-only) — registrado apenas com a API key configurada.
    ...(recallApiKey
      ? {
          recall: {
            url: new URL(`https://${recallRegion}.recall.ai/mcp`),
            requestInit: {
              headers: { Authorization: `Bearer ${recallApiKey}` },
            },
          },
        }
      : {}),
  },
});
