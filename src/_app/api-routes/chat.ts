import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse, jsonSchema, tool } from "ai";
import type { JSONSchema7 } from "ai";
import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { isBotOwner } from "@/server/recall/ownership";
import { checkRateLimit, rateLimitedResponse } from "@/shared/lib/rate-limit";

/** A v6 UIMessage as it arrives from the transport (only what we read/build). */
type UIMessageLike = {
  role: string;
  parts?: Array<{ type: string; text?: string }>;
};

/**
 * Builds a system message that pins the agent to the meeting the user has open,
 * so "summarize this", "who spoke most?", "what were the objections?" resolve to
 * `botId` without the user restating it. Returned as a v6 UIMessage to prepend.
 */
function meetingContextMessage(botId: string): UIMessageLike {
  return {
    role: "system",
    parts: [
      {
        type: "text",
        text:
          `The user is currently viewing the notebook for meeting botId="${botId}". ` +
          `When they refer to "this meeting", "this call", or ask about it without ` +
          `naming another, use this botId with the by-bot tools (get_transcript, ` +
          `summarize_meeting, get_participants, get_recording). Do not ask which ` +
          `meeting they mean.`,
      },
    ],
  };
}

// Shape of what AssistantChatTransport injects into the body (assistant-ui):
// tools: Record<name, { description?, parameters: JSONSchema7 }>.
type FrontendToolJSONSchema = {
  description?: string;
  parameters: JSONSchema7;
};

/**
 * Converts the tools sent by the frontend (assistant-ui frontend tools) into
 * Mastra clientTools. These are tools WITHOUT server-side `execute`: the agent
 * exposes them to the model, the model calls them, and execution happens in
 * the browser (the UI fulfills the tool-call and returns the result). This is
 * how `pick_date` / `connect_calendar` run their UI flow on the client.
 */
function toClientTools(
  tools: Record<string, FrontendToolJSONSchema> | undefined,
) {
  if (!tools) return undefined;
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters),
        // no `execute`: the client fulfills the call.
      }),
    ]),
  );
}

export async function POST(req: Request) {
  // Auth gate: chat consumes LLM (cost) and grants access to meeting tools.
  // Without a session, we don't serve — blocks quota abuse/DoS before any work.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Per-user rate limit: each turn hits the LLM (real $ on Bedrock/Fireworks).
  // Auth alone doesn't bound cost — a logged-in user could loop the endpoint and
  // burn the budget. 20 requests / 60s is generous for a human, hostile to a script.
  const rl = await checkRateLimit({
    key: `chat:${session.user.id}`,
    window: 60,
    max: 20,
  });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const params = await req.json();
  // The transport injects `tools` (JSON Schema) and — for multi-thread chat —
  // a `threadId` (the active sidebar thread). `meetingBotId` is sent by the
  // notebook so the agent knows which meeting is open. `agentId` selects which
  // agent handles the turn (see allowlist below). We forward tools as
  // clientTools and bind memory to that thread so Mastra persists/recalls per
  // conversation. The rest of `params` passes through unchanged to the handler.
  const {
    tools,
    threadId,
    meetingBotId,
    agentId: requestedAgentId,
    messages,
    ...rest
  } = params as {
    tools?: Record<string, FrontendToolJSONSchema>;
    threadId?: string;
    meetingBotId?: string;
    agentId?: string;
    messages?: UIMessageLike[];
  } & Record<string, unknown>;

  // Agent selection is an ALLOWLIST, never the raw body value: a caller could
  // otherwise name any registered agent (e.g. a sub-agent) or an unknown id.
  // `assistantAgent` is the default (home chat = the supervisor); the meeting
  // notebook asks for `minutesAgent` (the meeting specialist, talked to
  // directly). Anything else falls back to the supervisor.
  const AGENT_ALLOWLIST = ["assistantAgent", "minutesAgent"] as const;
  const agentId = AGENT_ALLOWLIST.includes(
    requestedAgentId as (typeof AGENT_ALLOWLIST)[number],
  )
    ? (requestedAgentId as (typeof AGENT_ALLOWLIST)[number])
    : "assistantAgent";

  // Meeting context: only inject if the caller actually OWNS the bot. An
  // unowned/forged meetingBotId is silently ignored — never surfaced to the
  // agent — so this can't be used to point the agent at another tenant's bot.
  // (The by-bot tools re-check ownership anyway; this is defense in depth.)
  const scopedMessages =
    meetingBotId && (await isBotOwner(meetingBotId, session.user.id))
      ? [meetingContextMessage(meetingBotId), ...(messages ?? [])]
      : messages;

  const { mastra } = await import("@/mastra");

  // Memory binding: `resource` is ALWAYS the session user id (never trusted
  // from the body — that would let a caller read another user's thread), and
  // `thread` is the active sidebar thread. Without a threadId (e.g. a brand-new
  // conversation before the sidebar assigns one), we omit memory and let the
  // handler run stateless for that turn.
  const memory = threadId
    ? { memory: { thread: threadId, resource: session.user.id } }
    : {};

  // version:'v6' required — assistant-ui types against AI SDK v6.
  const stream = await handleChatStream({
    mastra,
    agentId,
    params: {
      ...rest,
      messages: scopedMessages,
      ...memory,
      clientTools: toClientTools(tools),
    } as Parameters<typeof handleChatStream>[0]["params"],
    version: "v6",
    // handleChatStream masks stream errors by default (start→finish, no text).
    // Surface the real cause into the stream so a model/provider/processor
    // failure is diagnosable. Server-side we log ONLY the error message — never
    // the full error object, which can carry request/response bodies (user +
    // model content = PII) from the provider SDK.
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[chat] stream error:", message);
      return message;
    },
  } as Parameters<typeof handleChatStream>[0]);
  return createUIMessageStreamResponse({ stream });
}
