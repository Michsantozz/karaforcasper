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
 * connect_calendar — frontend tool that CONNECTS the Google calendar via chat.
 *
 * Analogous to connect_wallet, but via OAuth redirect (not an instant popup):
 *  1. `execute` runs in the browser: it queries /api/calendar/status. If
 *     already connected, it resolves right away ({ connected:true }).
 *  2. If not, `render` shows a "Connect Google Calendar" button. On click, it
 *     opens /api/calendar/google/start in a POPUP (Google consent). The
 *     callback saves the link in the DB and navigates the popup to
 *     /meetings?connected=1.
 *  3. We POLL /api/calendar/status until connected:true, close the popup, and
 *     resolve the execute Promise → the agent CONTINUES the loop
 *     (sendAutomaticallyWhen) and calls create_calendar_event.
 *
 * Doesn't rely on postMessage between windows: status polling is the source
 * of truth (the callback persists to our Postgres).
 */

type ConnectCalendarResult = {
  connected: boolean;
  email?: string | null;
  error?: string;
};

/** Queries the authenticated user's connected calendar status. */
async function fetchStatus(): Promise<ConnectCalendarResult> {
  try {
    const res = await fetch("/api/calendar/status", { cache: "no-store" });
    if (res.status === 401) {
      return { connected: false, error: "not authenticated — sign in first" };
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
      error: e instanceof Error ? e.message : "failed to query status",
    };
  }
}

/** Registry of resolvers per toolCallId (the execute Promise completes on click). */
const pending = new Map<string, (r: ConnectCalendarResult) => void>();

function ConnectCalendarCard({
  status,
  result,
  toolCallId,
}: ToolCallMessagePartProps<Record<string, never>, ConnectCalendarResult>) {
  const [phase, setPhase] = useState<"idle" | "connecting">("idle");
  const [localErr, setLocalErr] = useState<string | null>(null);

  // Already resolved (execute found a connection, or the flow finished).
  if (result) {
    return result.connected ? (
      <ToolCard icon={CalendarCheck2Icon} label="connect calendar" tone="success" meta="connected">
        <Row k="google" v={result.email ?? "account connected"} />
      </ToolCard>
    ) : (
      <ToolCard icon={XCircleIcon} label="connect calendar" tone="risk" meta="not connected">
        <Row k="error" v={result.error ?? "connection canceled"} />
      </ToolCard>
    );
  }

  // execute still pending → show the connect button.
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

    // Opens Google's consent screen in a popup.
    const popup = window.open(
      "/api/calendar/google/start",
      "casper-connect-calendar",
      "width=520,height=680,menubar=no,toolbar=no",
    );
    if (!popup) {
      setPhase("idle");
      setLocalErr("popup blocked — allow popups and try again");
      return;
    }

    // Poll the status until connected (or the popup closes / ~2min timeout).
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
          ? "timed out connecting the calendar"
          : "window closed without completing the connection";
        setLocalErr(msg);
        // Doesn't resolve as a terminal error — the user can retry from the
        // same card. We only resolve on success, or leave the agent waiting.
      }
    }, 1500);
  }

  const running = status.type === "running";
  return (
    <ToolCard
      icon={CalendarPlusIcon}
      label="connect calendar"
      running={running && phase === "connecting"}
      meta={phase === "connecting" ? "awaiting consent" : "action needed"}
    >
      <p className="font-mono text-[11px] text-muted-foreground">
        Connect your Google Calendar so CasperAgent can create meetings and
        schedule bots directly on your calendar.
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
            connecting…
          </>
        ) : (
          <>
            <CalendarPlusIcon className="size-3.5" />
            Connect Google Calendar
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
    "Connects the user's Google calendar VIA CHAT (shows a button that opens Google consent in a popup). ALWAYS use this when a calendar action fails due to no calendar connected (e.g. create_calendar_event / list_calendar_events returning 'no calendar connected'), BEFORE sending the user to settings. Returns { connected, email }. If connected:true, proceed with the calendar action the user requested.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  // execute: if a calendar is already connected, it resolves right away;
  // otherwise it returns a pending Promise (the resolver is called when
  // polling detects the connection).
  execute: async (_args, { toolCallId }) => {
    const st = await fetchStatus();
    if (st.connected) return st;
    return new Promise<ConnectCalendarResult>((resolve) => {
      pending.set(toolCallId, resolve);
    });
  },
  render: ConnectCalendarCard,
});

/* ── visual card (mirrors the other ToolUIs) ─────────────────────────────── */

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
