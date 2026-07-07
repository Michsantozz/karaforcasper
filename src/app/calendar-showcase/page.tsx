"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarIcon,
  UsersIcon,
  RadioIcon,
  BotIcon,
  CopyCheckIcon,
  VideoIcon,
  KeyRoundIcon,
  CalendarCheckIcon,
  PlayIcon,
  RotateCwIcon,
  CheckIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/shared/ui/button";

// INTERACTIVE showcase of the multi-user Recall.ai Calendar V2 flow. Each
// cell has a "run" button that animates the real flow (OAuth → creates
// calendar → webhook → schedules bot) with mock data — without touching the
// real Recall API or an OAuth provider. Viewport 1920x1080, route:
// /calendar-showcase
export default function CalendarShowcasePage() {
  return (
    <main className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-(--thread-frame-outer) p-4">
      <header className="flex items-center justify-between rounded-[8px] border bg-background px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-[5px] border bg-background">
            <CalendarCheckIcon className="size-3.5 text-(--thread-accent-primary)" />
          </span>
          <div className="flex flex-col">
            <span className="font-semibold text-sm tracking-tight">
              Recall.ai · Calendar V2 · Multi-User
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              calendar-showcase / connects N users' calendars → schedules bots
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Legend dot="primary" label="you manage OAuth" />
          <Legend dot="secondary" label="Recall manages tokens" />
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)" />
            api/v2
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-2 gap-3">
        <ConnectCell />
        <MultiUserCell />
        <WebhookCell />
        <ScheduleCell />
        <DedupCell />
        <ZoomCell />
        <TokenCell />
        <ArchitectureCell />
      </div>
    </main>
  );
}

/* ─────────────  hook: animated step machine  ───────────── */

// Runs a sequence of steps with delays. Each item = [label, ms].
function useFlow(steps: [string, number][]) {
  const [step, setStep] = useState(-1); // -1 = idle, steps.length = done
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStep(-1);
  }, []);

  const run = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStep(0);
    let acc = 0;
    steps.forEach(([, ms], i) => {
      acc += ms;
      timers.current.push(setTimeout(() => setStep(i + 1), acc));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return {
    step,
    run,
    reset,
    idle: step === -1,
    running: step >= 0 && step < steps.length,
    done: step >= steps.length,
    label: step >= 0 && step < steps.length ? steps[step][0] : null,
  };
}

/* ─────────────────────────  CELLS  ───────────────────────── */

// 1. CONNECT — provider OAuth → exchanges code for refresh_token → creates calendar
function ConnectCell() {
  const flow = useFlow([
    ["redirect → consent", 700],
    ["callback + auth code", 700],
    ["code → refresh_token", 700],
    ["POST /v2/calendars/", 800],
  ]);
  return (
    <Cell icon={CalendarIcon} label="connect calendar" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        The user authorizes on Google/Outlook. Your backend exchanges the
        code for a refresh_token and creates the calendar in Recall.
      </p>
      <KV k="platform" v="google_calendar" />
      <KV k="oauth_email" v="ana@company.com" />
      {flow.step >= 3 ? (
        <KV k="refresh_token" v="1//0gFx…long-lived" accent />
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          refresh_token ··· awaiting authorization code ···
        </p>
      )}
      {flow.done && <Confirmed label="calendar.id" value="cal_a1b2…9f3e" />}
    </Cell>
  );
}

// 2. MULTI-USER — N users, each with 1 calendar; recall_id ↔ user_id mapping
function MultiUserCell() {
  const users = [
    { who: "ana@company.com", plat: "google", cal: "cal_a1b2…9f3e" },
    { who: "bruno@company.com", plat: "outlook", cal: "cal_c3d4…7a1c" },
    { who: "caio@partner.io", plat: "google", cal: "cal_e5f6…2b8d" },
  ];
  const flow = useFlow([
    ["linking ana", 600],
    ["linking bruno", 600],
    ["linking caio", 600],
  ]);
  const linked = Math.max(0, Math.min(flow.step, users.length));
  return (
    <Cell icon={UsersIcon} label="multi-user calendars" kind="read" gold flow={flow}>
      <p className="text-xs text-muted-foreground">
        N users = N calendars in Recall. You map calendar.id ↔ user in your
        own DB. Each one has their own OAuth.
      </p>
      {users.map((u, idx) => {
        const on = idx < linked;
        return (
          <div
            key={u.who}
            className={`flex items-center gap-2 rounded-[5px] border px-3 py-1.5 transition-colors ${
              on
                ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft)"
                : "bg-background"
            }`}
          >
            {on ? (
              <CheckIcon className="size-3 text-(--thread-accent-primary)" />
            ) : (
              <span className="size-2 rounded-[1px] bg-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {u.who}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {u.plat}
            </span>
          </div>
        );
      })}
      <div className="flex items-center justify-between rounded-[5px] border bg-background px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          connected
        </span>
        <span className="font-mono font-semibold text-xs text-(--thread-accent-primary) tabular-nums">
          {linked} / {users.length}
        </span>
      </div>
    </Cell>
  );
}

// 3. WEBHOOK — calendar events arriving in real time
function WebhookCell() {
  const allEvents = [
    { t: "09:00:02", e: "calendar.sync_events", who: "ana" },
    { t: "09:00:02", e: "calendar.update", who: "bruno" },
    { t: "09:14:55", e: "event.created", who: "ana" },
    { t: "10:30:01", e: "event.updated", who: "caio" },
  ];
  const [count, setCount] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const run = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setCount(0);
    setStreaming(true);
    allEvents.forEach((_, i) => {
      timers.current.push(
        setTimeout(() => {
          setCount(i + 1);
          if (i === allEvents.length - 1) setStreaming(false);
        }, 600 * (i + 1)),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout);
    setCount(0);
    setStreaming(false);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const flow = {
    idle: count === 0 && !streaming,
    running: streaming,
    done: count === allEvents.length,
    run,
    reset,
    label: streaming ? "receiving…" : null,
  };

  return (
    <Cell icon={RadioIcon} label="webhook sync" kind="read" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Calendar created → Recall sends update webhooks to your webhook_url.
        You react and schedule bots.
      </p>
      {allEvents.slice(0, count).map((ev, i) => {
        const isLast = i === count - 1 && streaming;
        return (
          <div
            key={ev.t + ev.e}
            className="flex items-center gap-2 rounded-[5px] border bg-background px-3 py-1.5"
          >
            <span
              className={`size-1.5 rounded-[1px] ${
                isLast
                  ? "animate-pulse bg-(--thread-accent-primary)"
                  : "bg-muted-foreground"
              }`}
            />
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
              {ev.t}
            </span>
            <span
              className={`min-w-0 flex-1 truncate font-mono text-xs ${
                isLast ? "text-(--thread-accent-primary)" : ""
              }`}
            >
              {ev.e}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {ev.who}
            </span>
          </div>
        );
      })}
      {/* flow.idle is plain state (count/streaming); the linter mistakenly
          flags the inline `flow` object's ref. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {flow.idle && (
        <p className="font-mono text-[10px] text-muted-foreground">
          run → webhooks arrive in real time
        </p>
      )}
    </Cell>
  );
}

// 4. SCHEDULE — schedules a bot for a calendar event
function ScheduleCell() {
  const flow = useFlow([
    ["fetch event", 600],
    ["POST /calendar_events/{id}/bot", 800],
    ["bot scheduled · join_at", 700],
  ]);
  return (
    <Cell icon={BotIcon} label="schedule bot" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        For every event with a meeting link, schedules a bot. Reschedule?
        Call it again — the previous bot is overwritten.
      </p>
      <KV k="event" v="Sync Q3 · 10:30" />
      <KV k="meeting_url" v="meet.google.com/abc-…" />
      <KV k="join_at" v="2026-06-24T10:30Z" accent />
      {flow.done && <Confirmed label="bot.id" value="bot_7f2a…joining" />}
    </Cell>
  );
}

// 5. DEDUP — 2 users on the same event → you dedupe to 1 bot
function DedupCell() {
  const flow = useFlow([
    ["ana invited", 600],
    ["bruno invited", 600],
    ["dedup_key match → 1 bot", 800],
  ]);
  const invites = [
    { who: "ana", cal: "cal_a1b2" },
    { who: "bruno", cal: "cal_c3d4" },
  ];
  const seen = Math.max(0, Math.min(flow.step, invites.length));
  return (
    <Cell icon={CopyCheckIcon} label="dedup · shared event" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Recall does NOT dedupe bots. If ana and bruno share the same event,
        you dedupe by meeting_url → 1 bot, not 2.
      </p>
      {invites.map((iv, idx) => {
        const on = idx < seen;
        return (
          <div
            key={iv.who}
            className={`flex items-center gap-2 rounded-[5px] border px-3 py-1.5 transition-colors ${
              on ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft)" : "bg-background"
            }`}
          >
            {on ? (
              <CheckIcon className="size-3 text-(--thread-accent-primary)" />
            ) : (
              <span className="size-2 rounded-[1px] bg-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {iv.who}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {iv.cal}
            </span>
          </div>
        );
      })}
      {flow.done ? (
        <Confirmed label="dedup_key" value="1 bot · meet.google.com/abc" />
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          dedup_key = meeting_url → 1 bot per meeting
        </p>
      )}
    </Cell>
  );
}

// 6. ZOOM — Zoom's native OAuth path (no calendar)
function ZoomCell() {
  const flow = useFlow([
    ["POST /zoom_oauth_apps/", 600],
    ["POST /zoom_oauth_credentials/", 800],
    ["sync_meetings", 700],
  ]);
  return (
    <Cell icon={VideoIcon} label="zoom oauth (native)" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Zoom has its own path: 1 credential per Zoom user. Covers recording
        meetings from the Zoom account directly, without going through the
        calendar.
      </p>
      <KV k="app" v="zoom_oauth_app" />
      <KV k="credential" v="1 per Zoom user" />
      {flow.done ? (
        <Confirmed label="status" value="credential · valid" />
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          Zoom links inside the calendar → covered by Calendar V2
        </p>
      )}
    </Cell>
  );
}

// 7. TOKEN — long-lived refresh_token; revoke → reconnect
function TokenCell() {
  const flow = useFlow([
    ["Recall auto-refresh", 700],
    ["user revokes permission", 700],
    ["calendar → disconnected", 700],
    ["reconnect → PATCH calendar", 800],
  ]);
  const states = ["connected", "connected", "disconnected", "connected"];
  const cur = flow.idle ? "connected" : states[Math.min(flow.step, 3)];
  const bad = cur === "disconnected";
  return (
    <Cell icon={KeyRoundIcon} label="token lifecycle" kind="read" flow={flow}>
      <p className="text-xs text-muted-foreground">
        refresh_token is long-lived — Recall renews the access token on its
        own. It only breaks if the user revokes access or changes their
        password.
      </p>
      <div
        className={`flex items-center justify-between rounded-[5px] border px-3 py-2 transition-colors ${
          bad
            ? "border-(--thread-accent-secondary) bg-(--thread-accent-secondary)/10"
            : "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft)"
        }`}
      >
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          calendar.status
        </span>
        <span
          className={`font-mono font-semibold text-xs ${
            bad ? "text-(--thread-accent-secondary)" : "text-(--thread-accent-primary)"
          }`}
        >
          {cur}
        </span>
      </div>
      {flow.done && (
        <Confirmed label="recovery" value="new refresh_token saved" />
      )}
    </Cell>
  );
}

// 8. ARCHITECTURE — architecture frame (static)
function ArchitectureCell() {
  const steps = [
    "OAuth client per provider",
    "user authorizes → refresh_token",
    "POST /v2/calendars/ → calendar.id",
    "map calendar.id ↔ user in the DB",
    "webhook → schedule bot",
  ];
  return (
    <div className="flex flex-col rounded-[8px] border border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) p-1">
      <div className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-[10px] text-(--thread-accent-primary) uppercase tracking-wider">
        <CalendarCheckIcon className="size-3.5" />
        calendar v2 flow
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 rounded-[5px] border bg-background p-3">
        {steps.map((s, idx) => (
          <div key={s} className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-(--thread-accent-primary) tabular-nums">
              {String(idx + 1).padStart(2, "0")}
            </span>
            <span className="size-1.5 rounded-[1px] bg-(--thread-accent-primary)" />
            <span className="min-w-0 flex-1 truncate text-xs">{s}</span>
          </div>
        ))}
        <p className="mt-auto font-mono text-[10px] text-muted-foreground">
          you: OAuth · Recall: tokens + sync + bots
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────  PRIMITIVES  ───────────────────────── */

type FlowState = {
  idle: boolean;
  running: boolean;
  done: boolean;
  run: () => void;
  reset: () => void;
  label: string | null;
};

function Cell({
  icon: Icon,
  label,
  kind,
  gold,
  flow,
  children,
}: {
  icon: LucideIcon;
  label: string;
  kind: "read" | "write";
  gold?: boolean;
  flow: FlowState;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col rounded-[8px] p-1 ${
        gold ? "bg-(--thread-accent-primary-soft)" : "bg-(--thread-frame-outer)"
      }`}
    >
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          <Icon className="size-3.5" />
          {label}
        </span>
        <div className="flex items-center gap-2">
          {flow.running && flow.label && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
              <span className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)" />
              {flow.label}
            </span>
          )}
          {flow.done && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
              <CheckIcon className="size-3" />
              done
            </span>
          )}
          {flow.idle && (
            <span
              className={`flex items-center gap-1 font-mono text-[10px] ${
                kind === "read"
                  ? "text-muted-foreground"
                  : "text-(--thread-accent-secondary)"
              }`}
            >
              <span
                className={`size-1.5 rounded-[1px] ${
                  kind === "read"
                    ? "bg-muted-foreground"
                    : "bg-(--thread-accent-secondary)"
                }`}
              />
              {kind}
            </span>
          )}
          <Button
            variant="outline"
            size="xs"
            className="rounded-[5px] font-mono text-[10px]"
            onClick={flow.done ? flow.reset : flow.run}
            disabled={flow.running}
          >
            {flow.done ? (
              <RotateCwIcon className="size-3" />
            ) : (
              <PlayIcon className="size-3" />
            )}
            {flow.done ? "reset" : "run"}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-[5px] border bg-background p-3">
        {children}
      </div>
    </div>
  );
}

function KV({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded-[5px] border px-3 py-2 ${
        accent
          ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft)"
          : "bg-background"
      }`}
    >
      <span
        className={`font-mono text-[10px] uppercase tracking-wider ${
          accent ? "text-(--thread-accent-primary)" : "text-muted-foreground"
        }`}
      >
        {k}
      </span>
      <span
        className={`font-mono text-xs tabular-nums ${
          accent ? "font-semibold text-(--thread-accent-primary)" : ""
        }`}
      >
        {v}
      </span>
    </div>
  );
}

function Confirmed({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[5px] border border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) px-3 py-2">
      <CheckIcon className="size-3.5 text-(--thread-accent-primary)" />
      <span className="font-mono text-[10px] text-(--thread-accent-primary) uppercase tracking-wider">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-(--thread-accent-primary)">
        {value}
      </span>
    </div>
  );
}

function Legend({ dot, label }: { dot: "primary" | "secondary"; label: string }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <span
        className={`size-2 rounded-[1px] ${
          dot === "primary"
            ? "bg-(--thread-accent-primary)"
            : "bg-(--thread-accent-secondary)"
        }`}
      />
      {label}
    </span>
  );
}
