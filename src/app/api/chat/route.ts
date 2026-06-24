import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse } from "ai";
import { mastra } from "@/mastra";

export const maxDuration = 60;

export async function POST(req: Request) {
  const params = await req.json();
  // version:'v6' obrigatório — assistant-ui tipa contra AI SDK v6.
  const stream = await handleChatStream({
    mastra,
    agentId: "casperAgent",
    params,
    version: "v6",
  });
  return createUIMessageStreamResponse({ stream });
}
