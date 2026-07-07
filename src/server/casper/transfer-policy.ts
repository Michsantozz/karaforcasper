import "server-only";

/**
 * AGENT wallet spending policy — enforcement in CODE, not in the prompt.
 *
 * Reason: `transfer_cspr` signs and broadcasts on-chain funds from the
 * agent's wallet. Previously, the only safeguard was a textual instruction in
 * the system prompt ("confirm with the user") — a convention, not a
 * guarantee: prompt injection via chat or a hallucination in the autonomous
 * loop was enough to drain the wallet. Here the policy is checked in code,
 * fail-closed, independent of what the LLM decides.
 *
 * Layers:
 *  1. Network floor (MIN_TRANSFER_CSPR): Casper rejects a native transfer
 *     below 2.5 CSPR with -32016. We block it BEFORE signing/paying gas —
 *     otherwise every small transfer (e.g., the default 1 CSPR autonomous
 *     heartbeat) burns gas and fails.
 *  2. Per-transaction cap (MAX_TRANSFER_CSPR).
 *  3. Destination allowlist (TRANSFER_ALLOWLIST) — if set, only addresses in it.
 *  4. Fail-closed: invalid values (NaN/≤0/out of range) are rejected, and a
 *     MISCONFIGURED cap (non-numeric env) is treated as an error, not as "no
 *     cap" — otherwise the spending limit would silently disappear.
 *
 * The human-in-the-loop (Mastra's requireApproval) is the last layer, in the
 * tool. These guards still hold even if the approval is bypassed in the handler.
 */

/**
 * Network floor for a native transfer, in CSPR. The node rejects anything
 * below this (-32016 "insufficient transfer amount"). Protocol constant, not configurable.
 */
export const MIN_TRANSFER_CSPR = 2.5;

/** Per-transfer cap for the agent, in CSPR. Conservative default: 5 CSPR. */
export const MAX_TRANSFER_CSPR = Number(
  process.env.AGENT_MAX_TRANSFER_CSPR ?? "5",
);

/**
 * Destination allowlist (public keys hex, comma-separated). If empty, there's
 * no destination restriction — recommended to set in production. Normalized
 * to lowercase for stable comparison.
 */
const TRANSFER_ALLOWLIST: ReadonlySet<string> = new Set(
  (process.env.AGENT_TRANSFER_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export class TransferPolicyError extends Error {
  constructor(
    readonly code:
      | "amount_invalid"
      | "amount_below_minimum"
      | "amount_exceeds_limit"
      | "destination_not_allowed"
      | "policy_misconfigured",
    message: string,
  ) {
    super(message);
    this.name = "TransferPolicyError";
  }
}

/**
 * Validates an agent transfer against the policy. Throws TransferPolicyError
 * (fail-closed) if any rule fails. Returns void if approved.
 */
export function assertTransferAllowed(args: {
  toPublicKeyHex: string;
  amountCspr: number;
}): void {
  const { toPublicKeyHex, amountCspr } = args;

  // A misconfigured cap (non-numeric env → NaN) is an ERROR, not "no cap".
  // Without this check, `amountCspr > NaN` would always be false and the
  // spending limit would silently disappear. Fail-closed: reject until the operator fixes it.
  if (!Number.isFinite(MAX_TRANSFER_CSPR) || MAX_TRANSFER_CSPR <= 0) {
    throw new TransferPolicyError(
      "policy_misconfigured",
      `invalid AGENT_MAX_TRANSFER_CSPR: ${process.env.AGENT_MAX_TRANSFER_CSPR}`,
    );
  }

  if (!Number.isFinite(amountCspr) || amountCspr <= 0) {
    throw new TransferPolicyError(
      "amount_invalid",
      `invalid transfer amount: ${amountCspr}`,
    );
  }

  if (amountCspr < MIN_TRANSFER_CSPR) {
    throw new TransferPolicyError(
      "amount_below_minimum",
      `transfer of ${amountCspr} CSPR is below the network minimum (${MIN_TRANSFER_CSPR} CSPR)`,
    );
  }

  if (amountCspr > MAX_TRANSFER_CSPR) {
    throw new TransferPolicyError(
      "amount_exceeds_limit",
      `transfer of ${amountCspr} CSPR exceeds the cap of ${MAX_TRANSFER_CSPR} CSPR`,
    );
  }

  if (
    TRANSFER_ALLOWLIST.size > 0 &&
    !TRANSFER_ALLOWLIST.has(toPublicKeyHex.toLowerCase())
  ) {
    throw new TransferPolicyError(
      "destination_not_allowed",
      `destination ${toPublicKeyHex} is not on the agent's allowlist`,
    );
  }
}
