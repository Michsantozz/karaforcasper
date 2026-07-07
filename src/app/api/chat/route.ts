import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse, jsonSchema, tool } from "ai";
import type { JSONSchema7 } from "ai";
import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";

export const maxDuration = 60;

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
 * how `connect_wallet` / `sign_with_wallet` open the Casper Wallet popup on
 * the client.
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
  // Auth gate: chat consumes LLM (cost) and grants access to on-chain tools.
  // Without a session, we don't serve — blocks quota abuse/DoS before any work.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const params = await req.json();
  // The transport injects `tools` (JSON Schema). We forward them as clientTools —
  // the rest of `params` passes through unchanged to the handler.
  const { tools, ...rest } = params as {
    tools?: Record<string, FrontendToolJSONSchema>;
  } & Record<string, unknown>;

  const { mastra } = await import("@/mastra");

  // version:'v6' required — assistant-ui types against AI SDK v6.
  const stream = await handleChatStream({
    mastra,
    agentId: "assistantAgent",
    params: { ...rest, clientTools: toClientTools(tools) } as Parameters<
      typeof handleChatStream
    >[0]["params"],
    version: "v6",
  });
  return createUIMessageStreamResponse({ stream });
}
