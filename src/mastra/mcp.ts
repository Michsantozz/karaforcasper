import { MCPClient } from "@mastra/mcp";

/**
 * MCP client connecting the agent to the Casper ecosystem's MCP servers.
 *
 * - csprTrade: DEX (swaps, quotes, liquidity, portfolio). Public, no API key.
 * - csprCloud: blockchain queries (balance, blocks, deploys, NFT, staking).
 *   Requires CSPR_CLOUD_API_KEY — only registered when the key is present.
 * - recall: read-only Recall.ai (bots, recordings, calendar, docs).
 *   Requires RECALL_API_KEY. Writes (create/schedule/control bot) do NOT come
 *   from the MCP — that's in src/mastra/tools/recall.tool.ts (REST). Here it's
 *   read-only.
 *
 * Consumed in the agent via `tools: async () => mcp.listTools()` (DynamicArgument),
 * the canonical pattern: resolved per request, no top-level await at boot.
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
    // CSPR.cloud testnet — only registered when the API key is configured.
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
    // Recall.ai (read-only) — only registered when the API key is configured.
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
