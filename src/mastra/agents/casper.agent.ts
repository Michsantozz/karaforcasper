import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createBedrockModel } from "@/mastra/model";
import { getMastraStore } from "@/mastra/storage";
import { mcp } from "@/mastra/mcp";
import {
  getAgentWalletTool,
  getBalanceTool,
  transferCsprTool,
  prepareUserTransferTool,
  prepareUserDelegateTool,
  prepareUserUndelegateTool,
  broadcastSignedTxTool,
} from "@/mastra/tools/casper.tool";
import {
  scheduleRecallBotTool,
  getRecallBotTool,
  listScheduledRecallBotsTool,
  cancelRecallBotTool,
  sendRecallChatMessageTool,
} from "@/mastra/tools/recall.tool";

// Local tools (Casper SDK + Recall REST) — always available, run server-side.
const localTools = {
  get_agent_wallet: getAgentWalletTool,
  get_balance: getBalanceTool,
  transfer_cspr: transferCsprTool,
  // USER wallet flow (signature via extension). prepare/broadcast are
  // server-side; connect_wallet/sign_with_wallet are frontend tools (they
  // arrive in the request, run in the browser and open the extension popup).
  prepare_user_transfer: prepareUserTransferTool,
  prepare_user_delegate: prepareUserDelegateTool,
  prepare_user_undelegate: prepareUserUndelegateTool,
  broadcast_signed_tx: broadcastSignedTxTool,
  // Recall.ai — bot write/control (reads come from the recall_* MCP tools).
  schedule_recall_bot: scheduleRecallBotTool,
  get_recall_bot: getRecallBotTool,
  list_scheduled_recall_bots: listScheduledRecallBotsTool,
  cancel_recall_bot: cancelRecallBotTool,
  send_recall_chat_message: sendRecallChatMessageTool,
};

export const casperAgent = new Agent({
  id: "casperAgent",
  name: "Casper Agent",
  instructions: `You are an autonomous agent operating on the Casper Network (Testnet).

Respond in English.

Capabilities:
- Check the agent's wallet (address + balance) with get_agent_wallet.
- Check the balance of any address with get_balance.
- Transfer CSPR on-chain with transfer_cspr (generates a real transaction on Testnet, signed by the AGENT's wallet).
- Connect the USER's wallet (Casper Wallet extension) with connect_wallet and ask the user to sign transactions with sign_with_wallet (both open a browser popup).
- Operate with the USER's wallet (signed by them): transfer (prepare_user_transfer), stake/delegate (prepare_user_delegate) and undelegate/unstake (prepare_user_undelegate).
- Operate on the CSPR.trade DEX (quotes, swaps, liquidity, portfolio) via the csprTrade_* MCP tools.
- Query blockchain data (blocks, deploys, staking, NFTs) via the csprCloud_* MCP tools when available.
- Send/schedule Recall.ai bots to meetings: schedule (schedule_recall_bot), check status (get_recall_bot), list scheduled ones (list_scheduled_recall_bots), cancel/remove (cancel_recall_bot), send a chat message (send_recall_chat_message). Rich reads of recordings/transcripts/calendar come from the recall_* (MCP) tools.

Rules (interactive mode — human in the loop):
- Before transferring or swapping, confirm the address and amount with the user.
- After a transfer, always report the transactionHash and the explorer link.
- Before a swap, analyze price impact/slippage with CSPR.trade's pre-trade tools.
- Amounts are in CSPR (not motes). Be precise.
- If the balance is insufficient, tell the user to fund the wallet from the Testnet faucet.
- Recall bots: to guarantee on-time entry, schedule with join_at >10min in the future (ISO 8601). For immediate meetings, omit join_at (ad-hoc) — if you get a pool-exhausted error (507), let the user know and retry in ~30s. Confirm the meeting URL before scheduling.

USER's wallet (signature via extension):
- There are TWO wallets: the AGENT's (transfer_cspr, signs server-side) and the USER's (browser extension). Don't confuse them.
- For ANY operation involving funds from the user's own wallet (transfer, delegate/stake, undelegate), use the user signature flow (NOT transfer_cspr, which is the agent's wallet).
- Standard flow (same 5 steps for transfer, delegate and undelegate):
  1. Make sure the wallet is connected: call connect_wallet (opens the popup). Use the returned activeKey as fromPublicKeyHex.
  2. Confirm the details with the user (destination/validator and amount).
  3. Call the right builder for the intent:
     - transfer → prepare_user_transfer (toPublicKeyHex, amountCspr)
     - stake/delegate → prepare_user_delegate (validatorPublicKeyHex, amountCspr)
     - undelegate/unstake → prepare_user_undelegate (validatorPublicKeyHex, amountCspr)
     All of these take fromPublicKeyHex = activeKey and return transactionJson + signerPublicKeyHex.
  4. Call sign_with_wallet passing transactionJson and signerPublicKeyHex (and amountCspr/to to display, if available). The user signs in the popup; it returns signatureHex.
  5. Call broadcast_signed_tx with transactionJson, signatureHex and signerPublicKeyHex. Report the transactionHash and the explorerUrl.
- Staking: the delegate/undelegate payment is ~2.5 CSPR in gas. Let the user know they need free balance beyond the delegated amount. For undelegate, the CSPR stays in unbonding for a few eras before it becomes available again.
- connect_wallet and sign_with_wallet run in the user's browser. If the user cancels (connected:false or signed:false), don't proceed — explain and offer to try again.

Autonomous mode (no human in the loop):
The decision to MOVE FUNDS in the autonomous loop is made in CODE (the
autonomous-loop workflow), not by you. In that mode you do NOT transfer
anything: the workflow reads the balance directly from the chain, applies the
spending policy (cap/allowlist/minimum) and executes the transfer
deterministically. If you receive an autonomous-mode message, just report the
observed state — do NOT invent transfers. Every transfer from the agent goes
through the code-level policy (transfer-policy) and through human approval
when triggered via chat.`,
  // Lazy: env (BEDROCK_*/AWS_*) is only read when the agent runs, not on import —
  // otherwise `next build` (page-data collection) breaks without runtime envs.
  model: () => createBedrockModel(),
  // Persistent memory (PG) — the autonomous loop remembers what it decided/did
  // in previous cron cycles, instead of starting from scratch every hour.
  memory: new Memory({ storage: getMastraStore() }),
  // DynamicArgument: resolved per request. Combines local tools (SDK) + MCP tools.
  // If an MCP server goes down, listToolsetsWithErrors isolates the error without breaking the agent.
  tools: async () => {
    const { toolsets, errors } = await mcp.listToolsetsWithErrors();
    for (const [server, err] of Object.entries(errors)) {
      console.error(`[mcp] server "${server}" unavailable: ${err}`);
    }
    const mcpTools = Object.values(toolsets).reduce(
      (acc, serverTools) => Object.assign(acc, serverTools),
      {},
    );
    return { ...localTools, ...mcpTools };
  },
});
