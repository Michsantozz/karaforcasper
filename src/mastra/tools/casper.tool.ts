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

// Tool: agent's balance. Read-only.
export const getAgentWalletTool = createTool({
  id: "get_agent_wallet",
  description:
    "Returns the public key (address) and the CSPR balance of the agent's wallet on Casper Testnet.",
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

// Tool: checks the balance of any address. Read-only.
export const getBalanceTool = createTool({
  id: "get_balance",
  description: "Checks the CSPR balance of a public key on Casper Testnet.",
  inputSchema: z.object({
    publicKeyHex: z.string().describe("Target public key in hex"),
  }),
  outputSchema: z.object({ balanceCspr: z.string() }),
  execute: async (input) => {
    const balanceCspr = await getBalanceCspr(input.publicKeyHex);
    return { balanceCspr };
  },
});

// Tool: transfers CSPR — WRITES on-chain (generates a transaction on Testnet).
// Moves funds from the AGENT's wallet → requireApproval (human-in-the-loop) as
// the 4th layer of defense. The first 3 (cap/allowlist/fail-closed) live in
// assertTransferAllowed and still apply even if approval is bypassed in the handler.
export const transferCsprTool = createTool({
  id: "transfer_cspr",
  description:
    "Transfers CSPR from the agent's wallet to a target address on Casper Testnet. Generates a real on-chain transaction. Use with care — moves funds.",
  requireApproval: true,
  inputSchema: z.object({
    toPublicKeyHex: z.string().describe("Recipient's public key in hex"),
    amountCspr: z.number().positive().describe("Amount in CSPR"),
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

// Tool: builds a transfer from the USER's wallet (not the agent's), WITHOUT
// signing. Returns the tx JSON to be signed by the Casper Wallet in the
// browser (via the frontend tool sign_with_wallet). Doesn't touch the network.
export const prepareUserTransferTool = createTool({
  id: "prepare_user_transfer",
  description:
    "Builds (without signing) a CSPR transfer from the USER's CONNECTED wallet. Use when the user asks to send funds from their own wallet (not the agent's). Requires the wallet to already be connected (use connect_wallet first to get the address). Returns a txId for sign_with_wallet (txId) and broadcast_signed_tx (txId).",
  inputSchema: z.object({
    fromPublicKeyHex: z
      .string()
      .describe("Public key (hex) of the user's active connected account"),
    toPublicKeyHex: z.string().describe("Recipient's public key in hex"),
    amountCspr: z.number().positive().describe("Amount in CSPR"),
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

// Tool: builds (without signing) a CSPR DELEGATION from the user's wallet to a
// validator (staking). Returns the JSON for sign_with_wallet → broadcast_signed_tx.
export const prepareUserDelegateTool = createTool({
  id: "prepare_user_delegate",
  description:
    "Builds (without signing) a CSPR delegation (staking) from the USER's CONNECTED wallet to a validator. Staking generates rewards. Requires a connected wallet (use connect_wallet first). Returns the JSON to be signed by the extension. Then use sign_with_wallet and broadcast_signed_tx.",
  inputSchema: z.object({
    fromPublicKeyHex: z
      .string()
      .describe("Public key (hex) of the user's active connected account"),
    validatorPublicKeyHex: z
      .string()
      .describe("Public key (hex) of the target validator"),
    amountCspr: z.number().positive().describe("Amount to delegate in CSPR"),
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

// Tool: builds (without signing) the UNDELEGATE of CSPR previously staked from
// the user's wallet. Returns the JSON for sign_with_wallet → broadcast_signed_tx.
export const prepareUserUndelegateTool = createTool({
  id: "prepare_user_undelegate",
  description:
    "Builds (without signing) the undelegate (unstake) of CSPR previously staked by the USER's CONNECTED wallet with a validator. Requires a connected wallet. Returns the JSON to be signed by the extension. Then use sign_with_wallet and broadcast_signed_tx.",
  inputSchema: z.object({
    fromPublicKeyHex: z
      .string()
      .describe("Public key (hex) of the user's active connected account"),
    validatorPublicKeyHex: z
      .string()
      .describe("Public key (hex) of the validator to undelegate from"),
    amountCspr: z.number().positive().describe("Amount to undelegate in CSPR"),
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

// Tool: receives the tx signed by the user's wallet (JSON + signatureHex) and
// submits it on-chain. WRITES to the network. Called by the agent after sign_with_wallet.
export const broadcastSignedTxTool = createTool({
  id: "broadcast_signed_tx",
  description:
    "Submits a transaction signed by the user's wallet on-chain. Pass txId (from prepare_user_*/setup) OR transactionJson, the signatureHex (from sign_with_wallet) and the signerPublicKeyHex. Generates a real transaction on Testnet.",
  inputSchema: z.object({
    txId: z
      .string()
      .optional()
      .describe("Short tx ID from the store (preferred). Use the same txId that was signed."),
    transactionJson: z
      .string()
      .optional()
      .describe("Tx JSON (fallback if there's no txId)"),
    signatureHex: z.string().describe("Signature hex from sign_with_wallet"),
    signerPublicKeyHex: z
      .string()
      .describe("Public key (hex) that signed — the user's account"),
  }),
  outputSchema: z.object({
    transactionHash: z.string(),
    explorerUrl: z.string(),
  }),
  execute: async (input) => {
    const json = input.txId ? getTx(input.txId) : input.transactionJson;
    if (!json)
      throw new Error(
        "Transaction not found: provide a valid (non-expired) txId or transactionJson.",
      );
    return broadcastUserSignedTransfer({
      transactionJson: json,
      signatureHex: input.signatureHex,
      signerPublicKeyHex: input.signerPublicKeyHex,
    });
  },
});
