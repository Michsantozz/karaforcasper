import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse } from "ai";
import { mastra } from "@/mastra";
import { getSession } from "@/features/auth/model/session";

export const maxDuration = 60;

/**
 * Chat do agente de reuniões. Exige sessão: as tools de agenda dependem do
 * usuário autenticado (better-auth). A sessão é lida via cookies pelo próprio
 * getSession dentro das tools; aqui só barramos o acesso não autenticado.
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
