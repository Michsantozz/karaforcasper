"use client";

/**
 * Meeting notebook page shell (client): notebook à esquerda | Thread real do
 * assistant à direita, painéis redimensionáveis (AssistantSidebar).
 *
 * The right pane talks to the MEETING SPECIALIST directly: `useChatRuntime` →
 * /api/chat with `agentId: "minutesAgent"` and the meeting's botId pinned in the
 * body. So the user converses with the agent that OWNS this meeting (summary,
 * decisions, action items, participants, transcript, dynamics) without the
 * supervisor's delegation hop.
 *
 * The conversation PERSISTS: one Mastra thread per meeting (`meeting-<botId>`,
 * resourceId-scoped to the user). The history adapter hydrates that thread when
 * the notebook reopens; the route binds memory to it so each turn is saved.
 */

import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  type GenericThreadHistoryAdapter,
  type MessageFormatRepository,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import type { UIMessage } from "ai";
import { sanitizeOrphanedToolCalls } from "@/shared/lib/sanitize-tool-calls";
import { AssistantSidebar } from "@/shared/ui/assistant-ui/assistant-sidebar";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { MeetingDetail } from "@/features/meetings/ui/MeetingDetail";

/** Stable Mastra thread id for a meeting's notebook conversation. Namespaced so
 *  it can't collide with the assistant sidebar's threads (which use assistant-ui
 *  local ids). local id === Mastra thread id, so no remapping. */
function meetingThreadId(botId: string): string {
  return `meeting-${botId}`;
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

/**
 * Load-only history for the meeting thread. Message persistence is server-side
 * (Mastra saves each turn in /api/chat via the bound memory), so `append` is a
 * no-op — this only hydrates on open. `withFormat` is REQUIRED by
 * `useChatRuntime`: it hands us the AI SDK v6 format and expects a repository of
 * v6 UIMessages back, exactly what /api/threads/[id]/messages returns (Mastra
 * messages already converted via toAISdkMessages). We wrap them as a linear
 * branch (each message's parent is the previous one).
 */
function createMeetingHistoryAdapter(threadId: string): ThreadHistoryAdapter {
  return {
    // Never called directly with useChatRuntime (withFormat path is used), but
    // the type requires it.
    async load() {
      return { messages: [] };
    },
    async append() {
      // No-op: Mastra persists messages server-side in /api/chat.
    },
    withFormat<TMessage>() {
      const adapter: GenericThreadHistoryAdapter<UIMessage> = {
        async load(): Promise<MessageFormatRepository<UIMessage>> {
          const { messages } = (await fetch(
            `/api/threads/${threadId}/messages`,
          ).then(jsonOrThrow)) as { messages: UIMessage[] };

          // Repair orphaned frontend tool-calls (left non-terminal when the user
          // navigated away mid-flow) so the notebook doesn't reopen stuck.
          const repaired = sanitizeOrphanedToolCalls(messages);

          let parentId: string | null = null;
          const items = repaired.map((message) => {
            const item = { parentId, message };
            parentId = message.id;
            return item;
          });
          return { messages: items };
        },
        async append() {
          // No-op: server-side persistence.
        },
      };
      return adapter as unknown as GenericThreadHistoryAdapter<TMessage>;
    },
  };
}

export function MeetingNotebook({ botId }: { botId: string }) {
  const threadId = useMemo(() => meetingThreadId(botId), [botId]);
  const history = useMemo(
    () => createMeetingHistoryAdapter(threadId),
    [threadId],
  );

  const runtime = useChatRuntime({
    // `body` rides along on every chat request:
    //  - agentId: talk to the meeting specialist directly (not the supervisor).
    //  - meetingBotId: the route verifies the caller owns it and pins the agent
    //    to this meeting so "summarize this", "who spoke most?" resolve without
    //    restating. Ownership is re-checked server-side.
    //  - threadId: binds Mastra memory to this meeting's thread (persist/recall).
    transport: new AssistantChatTransport({
      api: "/api/chat",
      body: {
        agentId: "minutesAgent",
        meetingBotId: botId,
        threadId,
      },
    }),
    adapters: { history },
    // After a frontend tool returns its result, resend so the agent continues.
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
