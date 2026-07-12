import { isToolUIPart, getToolName, type UIMessage } from "ai";

// Frontend (client-executed) tools: the agent calls them, the BROWSER fulfills
// them (pick a date, click connect, confirm send), and only then the flow should
// auto-resume so the agent continues. These are the ONLY tools whose completion
// should trigger an automatic resend to the agent.
export const CLIENT_TOOLS = new Set([
  "pick_date",
  "connect_calendar",
  "confirm_send_summary_email",
]);

/**
 * Predicate for assistant-ui's `sendAutomaticallyWhen`: resume the agent
 * automatically ONLY after a genuine CLIENT tool finishes.
 *
 * assistant-ui's stock `lastAssistantMessageIsCompleteWithToolCalls` resends
 * whenever the last assistant message ends with ANY completed tool call that
 * isn't flagged `providerExecuted`. Our agent's SERVER-side tools (searchAgent /
 * minutesAgent delegation, updateWorkingMemory, the Recall/calendar reads) arrive
 * already-executed WITH their result but are NOT reliably flagged
 * `providerExecuted` in the Mastra stream — so the stock predicate treats every
 * server tool turn as "a client tool just resolved", fires a resend, the agent
 * re-runs the whole turn, and it loops forever (observed: the same answer
 * regenerated N times, N POSTs to /api/chat).
 *
 * Fix: resend only when the last step's pending tool calls are all in the
 * CLIENT_TOOLS allowlist. Server tool turns no longer trigger a resend, killing
 * the loop while keeping the human-in-the-loop pick_date/connect flows working.
 */
export function shouldResumeAfterClientTool({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  const message = messages[messages.length - 1];
  if (!message || message.role !== "assistant") return false;

  // Only look at the LAST step (parts after the final step-start), matching the
  // stock predicate's scoping.
  const lastStepStart = message.parts.reduce(
    (last, part, index) => (part.type === "step-start" ? index : last),
    -1,
  );
  const toolParts = message.parts.slice(lastStepStart + 1).filter(isToolUIPart);
  if (toolParts.length === 0) return false;

  // Every pending tool call must be complete AND a known client tool. If any is a
  // server tool, this is a server turn — do NOT resend (that's what looped).
  return toolParts.every(
    (part) =>
      (part.state === "output-available" || part.state === "output-error") &&
      CLIENT_TOOLS.has(getToolName(part)),
  );
}
