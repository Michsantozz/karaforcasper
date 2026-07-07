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
 * Chat do agente de reuniões (/meetings).
 *
 * Gate de login: sem sessão, mostra "Entrar com Google". Com sessão, abre a
 * thread apontando para /api/meetings/chat, com barra de topo que reflete o
 * estado da agenda (conectada vs. conectar) e botão de sair.
 */
export function MeetingAssistant() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        carregando…
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
          Assistente de Reuniões
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Entre para enviar bots a reuniões, controlar a gravação e agendar bots
          pela sua agenda — tudo pela conversa.
        </p>
      </div>
      <Button
        onClick={() =>
          signIn.social({ provider: "google", callbackURL: "/meetings" })
        }
      >
        Entrar com Google
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
      /* mantém estado anterior */
    }
  }, []);

  useEffect(() => {
    // Busca inicial do status do calendar (fetch → setState async). É I/O de
    // montagem, não estado derivável em render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStatus();
    // ?connected=1 volta do OAuth de calendar — limpa a query e re-busca status.
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
      {/* ToolUIs registradas — substituem o JSON cru das tool-calls por cards. */}
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
                  agenda conectada
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
                  aria-label="Desconectar agenda"
                >
                  <CalendarXIcon className="size-3.5" />
                  {disconnecting ? "desconectando…" : "Desconectar"}
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
                Conectar agenda
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signOut()}
              aria-label="Sair"
            >
              <LogOutIcon className="size-3.5" />
              Sair
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

/** Empty state próprio do agente de reuniões (substitui o welcome do Casper). */
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
        Quem entra na sua reunião?
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Cole um link de reunião para enviar um bot, controle a gravação, ou
        conecte sua agenda e agende bots por evento — tudo pela conversa.
      </p>
    </div>
  );
}
