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

// Minutes schema reused by the notarization tools.
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

// --- Mock for E2E tests (no real Recall meeting) ------------------

// Sample minutes, identified by a friendly "demo id". Let you test the full
// flow (minutes → notarize → verify) without needing a real Recall.ai
// bot/transcript. Do NOT use in production.
const DEMO_MEETINGS: Record<string, z.infer<typeof meetingRecordSchema>> = {
  "demo-q3": {
    botId: "demo-q3",
    summary:
      "Q3 planning meeting. The team aligned on product priorities, approved the marketing budget, and assigned owners for the upcoming deliverables.",
    decisions: [
      "Approve the $50k marketing budget for Q3",
      "Launch the new notarization feature in July",
    ],
    actionItems: [
      { task: "Hire a product designer", owner: "Ana" },
      { task: "Close the contract with the infrastructure vendor", owner: "Bruno" },
      { task: "Prepare the demo for the buildathon", owner: "Carla" },
    ],
    participants: ["Ana", "Bruno", "Carla"],
    topics: ["budget", "Q3 roadmap", "hiring", "buildathon"],
  },
  "demo-pagamento": {
    botId: "demo-pagamento",
    summary:
      "Finance committee meeting. Decided on a payment that requires approval from multiple signers before it can be executed.",
    decisions: ["Pay 5 CSPR to the vendor, with approval from 2 of 2 signers"],
    actionItems: [
      { task: "Execute the 5 CSPR multisig payment to the vendor", owner: "Ana" },
    ],
    participants: ["Ana", "Bruno"],
    topics: ["payment", "multisig", "vendor"],
  },
};

const DEFAULT_DEMO = DEMO_MEETINGS["demo-q3"]!;

export const getMockMeetingTool = createTool({
  id: "get_mock_meeting",
  description:
    "Returns SAMPLE (mock) meeting minutes for testing, without needing a real Recall.ai bot. Available demoIds: 'demo-q3' (planning) and 'demo-pagamento' (finance committee with a payment action item). Use the result as input for notarize_meeting or to build a multisig.",
  inputSchema: z.object({
    demoId: z
      .enum(["demo-q3", "demo-pagamento"])
      .default("demo-q3")
      .describe("Which sample minutes to return"),
  }),
  outputSchema: meetingRecordSchema,
  execute: async (input) =>
    (input.demoId ? DEMO_MEETINGS[input.demoId] : undefined) ?? DEFAULT_DEMO,
});

// --- Notarization (Proof-of-Meeting) -------------------------------------

// Anchors the minutes hash on-chain. Signs with the AGENT's wallet
// (server-side), generates a real transaction immediately — no popup.
export const notarizeMeetingTool = createTool({
  id: "notarize_meeting",
  description:
    "Anchors (notarizes) a meeting's minutes hash on-chain on Casper, generating an immutable proof (proof-of-meeting). Use after summarize_meeting/get_participants: pass the summary, decisions, action items and participants. Signs with the agent's wallet — no user needed. Returns the minutes hash and the transactionHash.",
  inputSchema: z.object({
    record: meetingRecordSchema.describe(
      "The minutes: result of summarize_meeting + participants from get_participants",
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

// Verifies a notarization: reads on-chain and (if the minutes are provided)
// checks whether the hash matches.
export const verifyMeetingTool = createTool({
  id: "verify_meeting",
  description:
    "Verifies a meeting notarization: reads the on-chain transaction by transactionHash, extracts the anchored hash and, if the minutes are provided, recomputes and compares it — proving that the minutes match the on-chain record.",
  inputSchema: z.object({
    transactionHash: z.string().describe("Hash of the notarization tx"),
    record: meetingRecordSchema
      .optional()
      .describe("Minutes to check against the on-chain hash (optional)"),
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

// --- Payment multisig (financial action item) ---------------------

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

// Configures the account as a NATIVE MULTISIG (network enforces the quorum).
// Generates the session wasm deploys (add_account + update_thresholds) that
// the primary account signs.
export const setupMultisigAccountTool = createTool({
  id: "setup_multisig_account",
  description:
    "Configures an account as a Casper NATIVE MULTISIG: adds signers (associated keys with weight) and sets the quorum (thresholds). From then on the NETWORK enforces the quorum — unlike the demonstrable multisig. Returns a sequence of steps: each step.transactionJson must be signed by the PRIMARY account via sign_with_wallet and submitted with broadcast_signed_tx, IN ORDER. Warning: key_management_threshold cannot exceed the sum of weights controllable by the primary account, or the account gets locked out.",
  inputSchema: z.object({
    primaryPublicKeyHex: z
      .string()
      .describe("Primary (owner) account — the one that will be configured and signs the setup steps"),
    associates: z
      .array(
        z.object({
          publicKeyHex: z.string(),
          weight: z.number().int().positive(),
        }),
      )
      .describe("Signers to add as associated keys, with weight"),
    deploymentThreshold: z
      .number()
      .int()
      .positive()
      .describe("Sum of weights required to send transactions"),
    keyManagementThreshold: z
      .number()
      .int()
      .positive()
      .describe("Sum of weights required to manage the account's keys"),
    primaryWeight: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Weight of the primary key (must be >= keyManagementThreshold so the account doesn't get locked out). Default: keyManagementThreshold.",
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

// Builds a payment that requires multiple signatures (e.g., action item
// "pay X" decided in a meeting). Doesn't sign or submit it.
export const prepareMultisigPaymentTool = createTool({
  id: "prepare_multisig_payment",
  description:
    "Builds a CSPR payment that requires the signature of SEVERAL signers (multisig) before it's submitted — e.g., a financial action item decided in a meeting. Provide the payer wallet, the destination, the amount and the public keys of all signers. Returns the multisig state (who still needs to sign). Then, for each signer: sign_with_wallet → add_signature; once ready=true, broadcast_multisig.",
  inputSchema: z.object({
    fromPublicKeyHex: z.string().describe("Payer wallet (where the CSPR comes from)"),
    toPublicKeyHex: z.string().describe("Payment recipient"),
    amountCspr: z.number().positive().describe("Amount in CSPR"),
    signerPublicKeysHex: z
      .array(z.string())
      .describe("Public keys of ALL required signers"),
    threshold: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Quorum (number of signatures). Default: all signers"),
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

// Attaches a signature (from sign_with_wallet) to the multisig tx.
export const addSignatureTool = createTool({
  id: "add_signature",
  description:
    "Attaches ONE signature to the multisig transaction (from prepare_multisig_payment) after a signer signs with sign_with_wallet. Pass the current multisig state and the signatureHex + signerPublicKeyHex. Returns the updated state; once ready=true, call broadcast_multisig.",
  inputSchema: z.object({
    state: multisigStateSchema.describe("Current multisig state"),
    signatureHex: z.string().describe("Signature from sign_with_wallet"),
    signerPublicKeyHex: z.string().describe("Who signed (public key hex)"),
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

// Submits the multisig tx once the quorum has been reached.
export const broadcastMultisigTool = createTool({
  id: "broadcast_multisig",
  description:
    "Submits the multisig transaction on-chain once the signature quorum has been reached (state.ready === true). Pass state.transactionJson. Generates a real transaction on Testnet.",
  inputSchema: z.object({
    transactionJson: z.string().describe("transactionJson from the multisig state"),
    amountCspr: z
      .string()
      .optional()
      .describe("amount (state.amountCspr) — only for displaying in the confirmation card"),
    to: z
      .string()
      .optional()
      .describe("recipient (state.to) — only for displaying in the confirmation card"),
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
