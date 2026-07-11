"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import {
  CalendarPlusIcon,
  CalendarCheckIcon,
  CalendarXIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Thread } from "@/shared/ui/assistant-ui/thread";
import { ThreadList } from "@/shared/ui/assistant-ui/thread-list";
import { cn } from "@/shared/lib/utils";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { PickDateTool } from "@/features/meetings/ui/PickDateToolUI";
import { ConnectCalendarTool } from "@/features/meetings/ui/CalendarConnectToolUI";
import { createThreadListAdapter } from "@/features/assistant/model/thread-list-adapter";
import { createUploadAttachmentAdapter } from "@/features/assistant/model/attachment-adapter";

/**
 * Runtime for a single active thread. Wrapped by `useRemoteThreadListRuntime`,
 * which renders this once per active thread INSIDE the thread-list-item context
 * — so the transport can read the active thread's `id` (= the Mastra thread id,
 * since local id === remote id).
 *
 * The transport injects `threadId` into the /api/chat body so Mastra binds
 * memory to that thread (persist + recall). `resource` is NOT sent from the
 * client — the route derives it from the session (a client-supplied resource
 * would let a caller read another user's thread).
 */
function useChatThreadRuntime() {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: async ({ id, messages, body }) => ({
          // `id` is the active thread's remoteId (assistant-ui fills it in when
          // wrapped by the remote thread list). Re-include id/messages: when we
          // return a `body`, it fully replaces the transport's default body.
          body: { ...body, id, messages, threadId: id },
        }),
      }),
    [],
  );

  // Attachment adapter: uploads images/PDFs to object storage (MinIO/S3 via
  // /api/upload) and emits an image/file part the vision model reads. Stable
  // for the runtime's lifetime — it only closes over fetch.
  const attachments = useMemo(() => createUploadAttachmentAdapter(), []);

  return useChatRuntime({
    transport,
    adapters: { attachments },
    // After a frontend tool returns its result, automatically resend to the
    // agent so it continues the flow without needing a new message.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });
}

/**
 * The unified assistant chat. Merges what used to be split across `/` and
 * `/meetings`:
 * - ThreadList sidebar (multi-conversation history, persisted memory per thread)
 * - Calendar top bar (connected · email / connect / disconnect), always visible
 * - Meeting tool UIs + pick_date + connect_calendar (assistantAgent)
 *
 * Single agent (assistantAgent, /api/chat). It's the app's home chat.
 */
export function Assistant() {
  // Adapter is stable for the component's lifetime — it only closes over fetch.
  const adapter = useMemo(() => createThreadListAdapter(), []);
  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: useChatThreadRuntime,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* ToolUIs registered on the provider — render the agent's tool-calls.
          Meetings + connected calendar (Recall/Calendar). Without registration,
          list_calendar_events / summarize_meeting / etc. fall back to raw JSON. */}
      <MeetingToolUIs />
      {/* Clickable calendar in the chat — user picks the day, agent continues. */}
      <PickDateTool />
      {/* Connect Google Calendar via chat (button → OAuth popup → polling). */}
      <ConnectCalendarTool />

      {/* Two-pane layout: conversation sidebar (left) + active thread (right).
          Sits to the right of the app's fixed nav rail (page adds md:pl-14). */}
      <div className="flex h-dvh">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-background p-2 md:flex">
          <ThreadList />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <CalendarBar />
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

/* ── calendar top bar (merged from the old MeetingAssistant) ───────── */

type CalendarStatus = {
  connected: boolean;
  count: number;
  calendars: Array<{
    id: string;
    platform: string;
    email: string | null;
    status: string | null;
  }>;
};

/** Always-visible calendar status/control bar at the top of the chat. */
function CalendarBar() {
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/status");
      if (res.ok) setCalendar(await res.json());
    } catch {
      /* keep previous state */
    }
  }, []);

  useEffect(() => {
    // Initial calendar status fetch (fetch → async setState). Mount-time I/O,
    // not state derivable at render time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStatus();
    // ?connected=1 comes back from calendar OAuth — clear the query, refetch,
    // and confirm with a toast (the OAuth redirect gives no other feedback).
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) {
      window.history.replaceState({}, "", "/");
      refreshStatus();
      toast.success("Calendar connected", {
        description: "Your Google Calendar is linked. You're still signed in.",
      });
    }
  }, [refreshStatus]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/calendar/disconnect", { method: "POST" });
      if (res.ok) {
        // Make it explicit this only unlinks the calendar — the app session is
        // untouched, so the user does NOT get signed out.
        toast.success("Calendar disconnected", {
          description: "Only the calendar was unlinked — you're still signed in.",
        });
      } else {
        toast.error("Couldn't disconnect the calendar", {
          description: "Please try again.",
        });
      }
      await refreshStatus();
    } catch {
      toast.error("Couldn't disconnect the calendar", {
        description: "Please try again.",
      });
    } finally {
      setDisconnecting(false);
    }
  }, [refreshStatus]);

  const connected = calendar?.connected ?? false;
  const primaryEmail = calendar?.calendars[0]?.email ?? null;

  return (
    <header className="flex items-center justify-between gap-2 border-b bg-background px-4 py-2 pl-14 md:pl-4">
      {/* namespace eyebrow — matches the terminal header pattern */}
      <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-[1px]",
            connected
              ? "bg-(--thread-accent-primary)"
              : "animate-pulse bg-muted-foreground/50",
          )}
        />
        calendar
      </span>

      <div className="flex items-center gap-2">
        {connected ? (
          <>
            <span className="flex items-center gap-1.5 rounded-[5px] border border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) px-2.5 py-1 font-mono text-[11px] text-(--thread-accent-primary)">
              <CalendarCheckIcon className="size-3.5" />
              connected
              {primaryEmail ? (
                <span className="text-muted-foreground">· {primaryEmail}</span>
              ) : null}
              {calendar && calendar.count > 1 ? (
                <span className="text-muted-foreground">
                  +{calendar.count - 1}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={disconnect}
              disabled={disconnecting}
              aria-label="Disconnect calendar"
              className="flex items-center gap-1.5 rounded-[5px] border border-border bg-background px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-(--thread-accent-secondary) hover:text-(--thread-accent-secondary) disabled:opacity-50"
            >
              <CalendarXIcon className="size-3.5" />
              {disconnecting ? "disconnecting…" : "disconnect"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              window.location.href = "/api/calendar/google/start";
            }}
            className="flex items-center gap-1.5 rounded-[5px] border border-border bg-background px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-(--thread-accent-primary) hover:bg-(--thread-accent-primary-soft) hover:text-(--thread-accent-primary)"
          >
            <CalendarPlusIcon className="size-3.5" />
            connect calendar
          </button>
        )}
      </div>
    </header>
  );
}
