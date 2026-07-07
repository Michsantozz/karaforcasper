import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse, jsonSchema, tool } from "ai";
import type { JSONSchema7 } from "ai";
import { NextResponse } from "next/server";
import { mastra } from "@/mastra";
import { getSession } from "@/features/auth/model/session";

export const maxDuration = 60;

// Shape do que o AssistantChatTransport injeta no body (assistant-ui):
// tools: Record<name, { description?, parameters: JSONSchema7 }>.
type FrontendToolJSONSchema = {
  description?: string;
  parameters: JSONSchema7;
};

/**
 * Converte as tools enviadas pelo front (frontend tools do assistant-ui) em
 * clientTools do Mastra. São tools SEM `execute` server-side: o agente as expõe
 * ao modelo, o modelo as chama, e a execução acontece no browser (a UI cumpre
 * a tool-call e devolve o resultado). É assim que `connect_wallet` /
 * `sign_with_wallet` abrem o popup da Casper Wallet no cliente.
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
        // sem `execute`: o cliente cumpre a chamada.
      }),
    ]),
  );
}

export async function POST(req: Request) {
  // Gate de auth: o chat consome LLM (custo) e dá acesso às tools on-chain.
  // Sem sessão, não atende — barra abuso/DoS de cota antes de qualquer trabalho.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const params = await req.json();
  // O transport injeta `tools` (JSON Schema). Repassamos como clientTools —
  // o resto de `params` segue inalterado para o handler.
  const { tools, ...rest } = params as {
    tools?: Record<string, FrontendToolJSONSchema>;
  } & Record<string, unknown>;

  // version:'v6' obrigatório — assistant-ui tipa contra AI SDK v6.
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
