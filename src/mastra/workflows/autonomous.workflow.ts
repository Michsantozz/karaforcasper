import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

// Generic autonomous loop for the agent — perceive → decide → act, no human in the loop.
// This is the AGENTIC component required by the buildathon: the agent runs on a
// schedule, evaluates on-chain state, and decides on its own whether to execute a transaction.
//
// It's generic by design: the decision policy lives in the agent's prompt, so it
// serves any idea (yield-routing, RWA oracle, treasury, KYC...). Swapping the
// strategy = swapping instructions, not the wiring.

// 1. PERCEIVE — reads the agent's current on-chain state (balance + address).
const perceive = createStep({
  id: "perceive",
  inputSchema: z.object({}),
  outputSchema: z.object({
    publicKey: z.string(),
    balanceCspr: z.string(),
  }),
  execute: async ({ mastra }) => {
    const agent = mastra!.getAgent("casperAgent");
    const res = await agent.generate(
      "Check the agent's wallet and return ONLY the current state (address and balance). Do not execute any transactions in this step.",
    );
    // The text is informational; the canonical state comes from the tools called.
    // We read directly from the chain to get reliable data (without depending on LLM parsing).
    const { getAgentPublicKeyHex } = await import("@/server/casper/client");
    const { getBalanceCspr } = await import("@/server/casper/transfer");
    const publicKey = await getAgentPublicKeyHex();
    const balanceCspr = await getBalanceCspr(publicKey).catch(() => "0");
    void res;
    return { publicKey, balanceCspr };
  },
});

// 2. DECIDE + ACT — the LLM evaluates the state and autonomously decides whether to act.
//    The decision to SPEND is deterministic (code), not LLM text parsing:
//    an autonomous agent (no human in the loop) must NEVER move funds based on
//    regex over the model's output — pattern hallucination = transfer. Here
//    the policy ("balance > minimum → fixed-amount heartbeat") is evaluated in TS, and
//    transferCspr still applies cap/allowlist/fail-closed underneath.
const AUTONOMOUS_MIN_BALANCE_CSPR = Number(
  process.env.CASPER_AUTONOMOUS_MIN_BALANCE_CSPR ?? "5",
);
// Default = network floor (2.5). Below this the policy rejects (amount_below_minimum)
// and the heartbeat would never complete — the default must be >= MIN_TRANSFER_CSPR.
const AUTONOMOUS_HEARTBEAT_CSPR = Number(
  process.env.CASPER_AUTONOMOUS_HEARTBEAT_CSPR ?? "2.5",
);

/** Performs the heartbeat transfer. Injectable for testing. */
type TransferFn = (args: {
  toPublicKeyHex: string;
  amountCspr: number;
}) => Promise<{ transactionHash: string }>;

export interface DecideAndActConfig {
  /** Heartbeat target (empty = not configured → does not act). */
  heartbeatTarget: string;
  minBalanceCspr: number;
  heartbeatCspr: number;
}

export interface DecideResult {
  decision: string;
  acted: boolean;
}

/**
 * Deterministic decision to SPEND — the heart of the autonomous loop, isolated from the
 * Inngest wiring so it's testable without the infra. An agent with no human in the
 * loop must NEVER move funds via LLM text parsing; the policy is pure code here, and
 * `transfer` still applies cap/allowlist/fail-closed underneath.
 *
 * Fail-closed contract: any error from `transfer` → { acted: false }. Never
 * reports ambiguous success.
 */
export async function decideAction(
  balanceCspr: string,
  cfg: DecideAndActConfig,
  transfer: TransferFn,
): Promise<DecideResult> {
  const balance = Number(balanceCspr);

  if (!cfg.heartbeatTarget) {
    return {
      decision: "WAITING: CASPER_HEARTBEAT_TARGET not set.",
      acted: false,
    };
  }
  if (!Number.isFinite(balance) || balance <= cfg.minBalanceCspr) {
    return {
      decision: `WAITING: insufficient balance | BALANCE: ${balanceCspr} CSPR | MINIMUM: ${cfg.minBalanceCspr} CSPR`,
      acted: false,
    };
  }

  try {
    const res = await transfer({
      toPublicKeyHex: cfg.heartbeatTarget,
      amountCspr: cfg.heartbeatCspr,
    });
    return {
      decision: `ACTION: transfer | REASON: autonomous heartbeat | BALANCE: ${balanceCspr} CSPR | TX: ${res.transactionHash}`,
      acted: true,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown error";
    return {
      decision: `BLOCKED by spending policy: ${code}`,
      acted: false,
    };
  }
}

const decideAndAct = createStep({
  id: "decide-and-act",
  inputSchema: z.object({
    publicKey: z.string(),
    balanceCspr: z.string(),
  }),
  outputSchema: z.object({
    decision: z.string(),
    acted: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { transferCspr } = await import("@/server/casper/transfer");
    return decideAction(
      inputData.balanceCspr,
      {
        heartbeatTarget: process.env.CASPER_HEARTBEAT_TARGET ?? "",
        minBalanceCspr: AUTONOMOUS_MIN_BALANCE_CSPR,
        heartbeatCspr: AUTONOMOUS_HEARTBEAT_CSPR,
      },
      transferCspr,
    );
  },
});

export const autonomousWorkflow = createWorkflow({
  id: "autonomous-loop",
  inputSchema: z.object({}),
  outputSchema: z.object({
    decision: z.string(),
    acted: z.boolean(),
  }),
  // Runs every hour. Override via env not supported by literal cron;
  // adjust here if the demo needs a shorter cadence.
  cron: "0 * * * *",
})
  .then(perceive)
  .then(decideAndAct);

autonomousWorkflow.commit();
