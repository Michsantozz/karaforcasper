"use client";

import { useCallback, useEffect, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import {
  CalendarPlusIcon,
  CalendarCheckIcon,
  CalendarXIcon,
  LogOutIcon,
  VideoIcon,
} from "lucide-react";
import { Thread } from "@/shared/ui/assistant-ui/thread";
import { Button } from "@/shared/ui/button";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { signIn, signOut, useSession } from "@/features/auth/model/auth-client";

/**
 * Meeting agent chat (/meetings).
 *
 * Login gate: without a session, shows "Sign in with Google". With a
 * session, opens the thread pointing to /api/meetings/chat, with a top bar
 * reflecting the calendar state (connected vs. connect) and a sign-out button.
 */
export function MeetingAssistant() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        loading…
      </div>
    );
  }

  if (!session) return <LoginGate />;

  return <MeetingThread userName={session.user.name ?? session.user.email} />;
}

function LoginGate() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-5 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-[8px] border bg-background">
          <VideoIcon className="size-5 text-(--thread-accent-primary)" />
        </span>
        <h1 className="font-semibold text-lg tracking-tight">
          Meeting Assistant
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Sign in to send bots to meetings, control the recording, and
          schedule bots from your calendar — all through conversation.
        </p>
      </div>
      <Button
        onClick={() =>
          signIn.social({ provider: "google", callbackURL: "/meetings" })
        }
      >
        Sign in with Google
      </Button>
    </div>
  );
}

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

function MeetingThread({ userName }: { userName: string }) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/meetings/chat" }),
  });

  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/status");
      if (res.ok) setCalendar(await res.json());
    } catch {
      /* keep previous state */
    }
  }, []);

  useEffect(() => {
    // Initial calendar status fetch (fetch → async setState). This is
    // mount-time I/O, not state derivable at render time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStatus();
    // ?connected=1 comes back from calendar OAuth — clear the query and refetch status.
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) {
      window.history.replaceState({}, "", "/meetings");
      refreshStatus();
    }
  }, [refreshStatus]);

  const [disconnecting, setDisconnecting] = useState(false);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await fetch("/api/calendar/disconnect", { method: "POST" });
      await refreshStatus();
    } finally {
      setDisconnecting(false);
    }
  }, [refreshStatus]);

  const connected = calendar?.connected ?? false;
  const primaryEmail = calendar?.calendars[0]?.email ?? null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Registered ToolUIs — replace raw tool-call JSON with cards. */}
      <MeetingToolUIs />
      <div className="flex h-dvh flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2 pl-14 md:pl-4">
          <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <VideoIcon className="size-3.5 text-(--thread-accent-primary)" />
            meeting agent · {userName}
          </span>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <span className="flex items-center gap-1.5 rounded-[6px] border border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) px-2.5 py-1 font-mono text-[11px] text-(--thread-accent-primary)">
                  <CalendarCheckIcon className="size-3.5" />
                  calendar connected
                  {primaryEmail ? (
                    <span className="text-muted-foreground">
                      · {primaryEmail}
                    </span>
                  ) : null}
                  {calendar && calendar.count > 1 ? (
                    <span className="text-muted-foreground">
                      +{calendar.count - 1}
                    </span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={disconnect}
                  disabled={disconnecting}
                  aria-label="Disconnect calendar"
                >
                  <CalendarXIcon className="size-3.5" />
                  {disconnecting ? "disconnecting…" : "Disconnect"}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.href = "/api/calendar/google/start";
                }}
              >
                <CalendarPlusIcon className="size-3.5" />
                Connect calendar
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signOut()}
              aria-label="Sign out"
            >
              <LogOutIcon className="size-3.5" />
              Sign out
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <Thread components={{ Welcome: MeetingWelcome }} />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

/** Meeting agent's own empty state (replaces the Casper welcome). */
function MeetingWelcome() {
  return (
    <div className="mb-6 flex flex-col items-center gap-2 px-4 text-center">
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
        />
        meeting agent · recall.ai
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">
        Who&apos;s joining your meeting?
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Paste a meeting link to send a bot, control the recording, or connect
        your calendar and schedule bots per event — all through conversation.
      </p>
    </div>
  );
}
