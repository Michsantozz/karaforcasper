"use client";

import { useState } from "react";
import {
  CalendarCheck2Icon,
  CalendarPlusIcon,
  LoaderIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import {
  makeAssistantTool,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { cn } from "@/shared/lib/utils";

/**
 * connect_calendar — frontend tool que CONECTA a agenda Google pelo chat.
 *
 * Análogo ao connect_wallet, mas via OAuth redirect (não popup instantâneo):
 *  1. `execute` roda no browser: consulta /api/calendar/status. Se já conectado,
 *     resolve na hora ({ connected:true }).
 *  2. Se não, o `render` mostra um botão "Conectar Google Calendar". Ao clicar,
 *     abre /api/calendar/google/start numa POPUP (consent do Google). O callback
 *     grava o vínculo no DB e navega a popup para /meetings?connected=1.
 *  3. Fazemos POLLING em /api/calendar/status até connected:true, fechamos a
 *     popup e resolvemos a Promise do execute → o agente CONTINUA o loop
 *     (sendAutomaticallyWhen) e chama create_calendar_event.
 *
 * Não depende de postMessage entre janelas: o polling do status é a fonte da
 * verdade (o callback persiste no nosso Postgres).
 */

type ConnectCalendarResult = {
  connected: boolean;
  email?: string | null;
  error?: string;
};

/** Consulta o status da agenda conectada do usuário autenticado. */
async function fetchStatus(): Promise<ConnectCalendarResult> {
  try {
    const res = await fetch("/api/calendar/status", { cache: "no-store" });
    if (res.status === 401) {
      return { connected: false, error: "não autenticado — faça login primeiro" };
    }
    if (!res.ok) return { connected: false, error: `status ${res.status}` };
    const data = (await res.json()) as {
      connected: boolean;
      calendars?: Array<{ email?: string | null }>;
    };
    return {
      connected: data.connected,
      email: data.calendars?.[0]?.email ?? null,
    };
  } catch (e) {
    return {
      connected: false,
      error: e instanceof Error ? e.message : "falha ao consultar status",
    };
  }
}

/** Registro de resolvers por toolCallId (a Promise do execute completa no clique). */
const pending = new Map<string, (r: ConnectCalendarResult) => void>();

function ConnectCalendarCard({
  status,
  result,
  toolCallId,
}: ToolCallMessagePartProps<Record<string, never>, ConnectCalendarResult>) {
  const [phase, setPhase] = useState<"idle" | "connecting">("idle");
  const [localErr, setLocalErr] = useState<string | null>(null);

  // Já resolvido (execute achou conexão, ou o fluxo terminou).
  if (result) {
    return result.connected ? (
      <ToolCard icon={CalendarCheck2Icon} label="conectar agenda" tone="success" meta="conectada">
        <Row k="google" v={result.email ?? "conta conectada"} />
      </ToolCard>
    ) : (
      <ToolCard icon={XCircleIcon} label="conectar agenda" tone="risk" meta="não conectada">
        <Row k="erro" v={result.error ?? "conexão cancelada"} />
      </ToolCard>
    );
  }

  // execute ainda pendente → mostra o botão de conectar.
  function resolve(r: ConnectCalendarResult) {
    const fn = pending.get(toolCallId);
    if (fn) {
      pending.delete(toolCallId);
      fn(r);
    }
  }

  async function connect() {
    setLocalErr(null);
    setPhase("connecting");

    // Abre o consent do Google numa popup.
    const popup = window.open(
      "/api/calendar/google/start",
      "casper-connect-calendar",
      "width=520,height=680,menubar=no,toolbar=no",
    );
    if (!popup) {
      setPhase("idle");
      setLocalErr("popup bloqueada — permita popups e tente de novo");
      return;
    }

    // Poll do status até conectar (ou a popup fechar / timeout ~2min).
    const started = performance.now();
    const TIMEOUT_MS = 120_000;
    const timer = window.setInterval(async () => {
      const st = await fetchStatus();
      const popupClosed = popup.closed;
      const timedOut = performance.now() - started > TIMEOUT_MS;

      if (st.connected) {
        window.clearInterval(timer);
        try {
          popup.close();
        } catch {}
        resolve(st);
        return;
      }
      if (timedOut || (popupClosed && !st.connected)) {
        window.clearInterval(timer);
        try {
          popup.close();
        } catch {}
        setPhase("idle");
        const msg = timedOut
          ? "tempo esgotado ao conectar a agenda"
          : "janela fechada sem concluir a conexão";
        setLocalErr(msg);
        // Não resolve como erro terminal — o usuário pode tentar de novo pelo
        // mesmo card. Só resolvemos em sucesso, ou deixamos o agente esperando.
      }
    }, 1500);
  }

  const running = status.type === "running";
  return (
    <ToolCard
      icon={CalendarPlusIcon}
      label="conectar agenda"
      running={running && phase === "connecting"}
      meta={phase === "connecting" ? "aguardando consent" : "ação necessária"}
    >
      <p className="font-mono text-[11px] text-muted-foreground">
        Conecte seu Google Calendar para o CasperAgent criar reuniões e agendar
        bots direto na sua agenda.
      </p>
      <button
        type="button"
        onClick={connect}
        disabled={phase === "connecting"}
        className={cn(
          "mt-1 inline-flex items-center justify-center gap-2 rounded-[6px] px-3 py-2",
          "font-mono text-sm transition-colors",
          "bg-(--thread-accent-primary) text-background hover:opacity-90",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {phase === "connecting" ? (
          <>
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
            conectando…
          </>
        ) : (
          <>
            <CalendarPlusIcon className="size-3.5" />
            Conectar Google Calendar
          </>
        )}
      </button>
      {localErr && (
        <p className="font-mono text-[11px] text-red-500 dark:text-red-400">
          {localErr}
        </p>
      )}
    </ToolCard>
  );
}

export const ConnectCalendarTool = makeAssistantTool<
  Record<string, never>,
  ConnectCalendarResult
>({
  toolName: "connect_calendar",
  type: "frontend",
  description:
    "Conecta a agenda Google do usuário PELO CHAT (mostra um botão que abre o consent do Google numa popup). Use SEMPRE que uma ação de agenda falhar por falta de agenda conectada (ex.: create_calendar_event / list_calendar_events retornando 'nenhuma agenda conectada'), ANTES de mandar o usuário para configurações. Retorna { connected, email }. Se connected:true, prossiga com a ação de agenda que o usuário pediu.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  // execute: se já houver agenda conectada, resolve na hora; senão retorna uma
  // Promise pendente (o resolver é chamado quando o polling detecta a conexão).
  execute: async (_args, { toolCallId }) => {
    const st = await fetchStatus();
    if (st.connected) return st;
    return new Promise<ConnectCalendarResult>((resolve) => {
      pending.set(toolCallId, resolve);
    });
  },
  render: ConnectCalendarCard,
});

/* ── card visual (espelha os demais ToolUIs) ─────────────────────────────── */

type Tone = "default" | "success" | "risk";

function ToolCard({
  icon: Icon,
  label,
  meta,
  tone = "default",
  running = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  tone?: Tone;
  running?: boolean;
  children?: React.ReactNode;
}) {
  const accent =
    tone === "success"
      ? "bg-(--thread-accent-primary)"
      : tone === "risk"
        ? "bg-red-500"
        : "bg-(--thread-accent-secondary)";

  return (
    <div className="my-2 rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          {running ? (
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
          ) : (
            <Icon className="size-3.5" />
          )}
          meeting / {label}
        </span>
        {meta && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span aria-hidden className={cn("size-2 rounded-[1px]", accent)} />
            {meta}
          </span>
        )}
      </div>
      {children && (
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-3">
          {children}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
        {k}
      </span>
      <span className="break-all font-mono text-sm">{v}</span>
    </div>
  );
}
