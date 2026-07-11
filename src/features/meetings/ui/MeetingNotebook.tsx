"use client";

/**
 * Meeting notebook page shell (client): notebook à esquerda | Thread real do
 * assistant à direita, painéis redimensionáveis (AssistantSidebar). Mesma
 * composição do assistant principal — runtime real (useChatRuntime →
 * /api/chat) + MeetingToolUIs (cards no lugar do JSON cru dos tool-calls).
 *
 * Assim o usuário conversa com o agente SOBRE a reunião aberta (resumir de
 * novo, extrair ação, mandar bot pra próxima call) lado a lado com o notebook.
 */

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { AssistantSidebar } from "@/shared/ui/assistant-ui/assistant-sidebar";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { MeetingDetail } from "@/features/meetings/ui/MeetingDetail";

export function MeetingNotebook({ botId }: { botId: string }) {
  const runtime = useChatRuntime({
    // `body` rides along on every chat request: the route reads meetingBotId,
    // verifies the caller owns it, and tells the agent WHICH meeting is open —
    // so "summarize this", "what were the objections?" resolve to this bot
    // without the user restating it. Ownership is re-checked server-side.
    transport: new AssistantChatTransport({
      api: "/api/chat",
      body: { meetingBotId: botId },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Tool UIs do agente de reunião (cards no lugar do JSON cru). */}
      <MeetingToolUIs />
      <main className="h-dvh w-full bg-(--thread-frame-outer) font-sans text-foreground md:pl-14">
        <AssistantSidebar defaultSize={68} sidebarSize={32}>
          <MeetingDetail botId={botId} />
        </AssistantSidebar>
      </main>
    </AssistantRuntimeProvider>
  );
}
