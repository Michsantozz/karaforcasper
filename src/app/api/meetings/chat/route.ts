import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse } from "ai";
import { mastra } from "@/mastra";
import { getSession } from "@/features/auth/model/session";

export const maxDuration = 60;

/**
 * Meetings agent chat. Requires a session: calendar tools depend on the
 * authenticated user (better-auth). The session is read via cookies by
 * getSession itself inside the tools; here we only block unauthenticated access.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const params = await req.json();
  const stream = await handleChatStream({
    mastra,
    agentId: "meetingAgent",
    params,
    version: "v6",
  });
  return createUIMessageStreamResponse({ stream });
}
