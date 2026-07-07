"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRightLeftIcon,
  TagIcon,
  WalletIcon,
  KeyRoundIcon,
  ArchiveIcon,
  RadioIcon,
  CoinsIcon,
  ShieldCheckIcon,
  PlayIcon,
  RotateCwIcon,
  CheckIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/shared/ui/button";

// INTERACTIVE showcase of Casper's native functions. Each cell has a "run"
// button that animates the operation's real flow (build → sign → confirm)
// with mock data — without touching the chain or a wallet. Viewport
// 1920x1080, route: /casper-showcase
export default function CasperShowcasePage() {
  return (
    <main className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-(--thread-frame-outer) p-4">
      <header className="flex items-center justify-between rounded-[8px] border bg-background px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-[5px] border bg-background">
            <ShieldCheckIcon className="size-3.5 text-(--thread-accent-primary)" />
          </span>
          <div className="flex flex-col">
            <span className="font-semibold text-sm tracking-tight">
              Casper · Native Functions
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              casper-showcase / interactive demo / click run on each cell
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Legend dot="primary" label="read · no signature" />
          <Legend dot="secondary" label="write · signs + sends" />
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)" />
            casper-test
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-2 gap-3">
        <TransferCell />
        <TransferIdCell />
        <BalanceCell />
        <MultiSigCell />
        <NamedKeysCell />
        <SseCell />
        <StakingCell />
        <SummaryCell />
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

// 1. TRANSFER — build → sign → broadcast → confirmed
function TransferCell() {
  const flow = useFlow([
    ["building deploy", 600],
    ["wallet signing", 900],
    ["broadcasting", 800],
  ]);
  return (
    <Cell icon={ArrowRightLeftIcon} label="transfer" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Sends CSPR from one account to another. Like a wire transfer.
      </p>
      <KV k="from" v="0137bb…71b4a" />
      <KV k="to" v="02a1c8…9f3e2" />
      <KV k="amount" v="2.5 CSPR" accent />
      {flow.done && (
        <Confirmed label="deploy_hash" value="c9170ad1…34d9864" />
      )}
    </Cell>
  );
}

// 2. TRANSFER_ID — tags the payment
function TransferIdCell() {
  const flow = useFlow([
    ["tagging payment", 600],
    ["broadcasting", 700],
  ]);
  return (
    <Cell icon={TagIcon} label="transfer_id" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Tags a number onto the payment. Links money ↔ meeting.
      </p>
      <KV k="meeting" v="Standup Q3" />
      <KV k="transfer_id" v="#42007" accent />
      {flow.done ? (
        <Confirmed label="indexed" value="id #42007 → 1 transfer" />
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          on-chain query by id → meeting payments
        </p>
      )}
    </Cell>
  );
}

// 3. BALANCE — RPC query, the account number counts up
function BalanceCell() {
  const flow = useFlow([["querying RPC", 700]]);
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!flow.done) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVal(0);
      return;
    }
    // animates the number counting up to the final balance (RAF → setState is the point)
    const target = 1482.91;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 600);
      setVal(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flow.done]);

  return (
    <Cell icon={WalletIcon} label="balance" kind="read" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Looks up an account&apos;s balance. Pure read, no signature needed.
      </p>
      <div className="flex flex-col gap-1 rounded-[5px] border bg-background p-3">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          main purse
        </span>
        <span className="font-mono font-semibold text-2xl tabular-nums">
          {flow.idle ? "—" : val.toFixed(2)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          CSPR
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Mini label="staked" value={flow.done ? "500.00" : "—"} />
        <Mini label="available" value={flow.done ? "982.91" : "—"} />
      </div>
    </Cell>
  );
}

// 4. MULTI-SIG — keys sign one by one, weight accumulates up to threshold
function MultiSigCell() {
  const keys = [
    { who: "organizer", weight: 2 },
    { who: "member · A", weight: 1 },
    { who: "member · B", weight: 1 },
  ];
  // each step = one key signing
  const flow = useFlow([
    ["organizer signs", 700],
    ["member A signs", 700],
    ["member B signs", 700],
  ]);
  // accumulated weight = sum of the keys that have signed so far (step indicates how many)
  const signedCount = Math.max(0, Math.min(flow.step, keys.length));
  const accWeight = keys
    .slice(0, signedCount)
    .reduce((s, k) => s + k.weight, 0);
  const threshold = 2;
  const reached = accWeight >= threshold;

  return (
    <Cell
      icon={KeyRoundIcon}
      label="multi-sig · weights"
      kind="write"
      gold
      flow={flow}
    >
      <p className="text-xs text-muted-foreground">
        An account with multiple keys, each with a weight. A Casper differentiator.
      </p>
      {keys.map((k, idx) => {
        const signed = idx < signedCount;
        return (
          <div
            key={k.who}
            className={`flex items-center gap-2 rounded-[5px] border px-3 py-1.5 transition-colors ${
              signed
                ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft)"
                : "bg-background"
            }`}
          >
            <span className="font-mono text-[10px] text-muted-foreground">
              {String(idx + 1).padStart(2, "0")}
            </span>
            {signed ? (
              <CheckIcon className="size-3 text-(--thread-accent-primary)" />
            ) : (
              <span className="size-2 rounded-[1px] bg-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {k.who}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
              w{k.weight}
            </span>
          </div>
        );
      })}
      <div
        className={`flex items-center justify-between rounded-[5px] border px-3 py-1.5 transition-colors ${
          reached
            ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft)"
            : "bg-background"
        }`}
      >
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          weight {accWeight} / {threshold}
        </span>
        <span
          className={`font-mono font-semibold text-xs tabular-nums ${
            reached ? "text-(--thread-accent-primary)" : "text-muted-foreground"
          }`}
        >
          {reached ? "✓ pay released" : "locked"}
        </span>
      </div>
    </Cell>
  );
}

// 5. NAMED KEYS — hash → write → stored
function NamedKeysCell() {
  const flow = useFlow([
    ["sha-256 hashing", 600],
    ["writing to account", 800],
  ]);
  return (
    <Cell icon={ArchiveIcon} label="named keys" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        A drawer inside the account. Stores the summary&apos;s hash = proof of delivery.
      </p>
      <div className="rounded-[5px] border bg-background p-3">
        <KVInline k="key" v="summary-42007" />
        <Dashed />
        <div className="flex items-center gap-1.5">
          <ShieldCheckIcon className="size-3 text-(--thread-accent-primary)" />
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            sha-256
          </span>
        </div>
        <span className="mt-1 block break-all font-mono text-[10px] text-(--thread-accent-primary)">
          {flow.step >= 1
            ? "c9170ad1504fe1d8f560fd712ff3d0a4ede41b23…"
            : "··· awaiting hash ···"}
        </span>
      </div>
      {flow.done ? (
        <Confirmed label="stored" value="immutable · timestamped" />
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          immutable · anyone can verify
        </p>
      )}
    </Cell>
  );
}

// 6. SSE — event stream arriving in real time
function SseCell() {
  const allEvents = [
    { t: "07:42:01", e: "TransactionAccepted" },
    { t: "07:42:09", e: "TransactionProcessed" },
    { t: "07:42:09", e: "BlockAdded" },
    { t: "07:42:10", e: "FinalitySignature" },
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
    label: streaming ? "listening…" : null,
  };

  return (
    <Cell icon={RadioIcon} label="sse · event stream" kind="read" flow={flow}>
      <p className="text-xs text-muted-foreground">
        A doorbell: the node notifies instantly. Paid → releases the summary automatically.
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
          </div>
        );
      })}
      {/* flow.idle is plain state; the linter mistakenly flags the `flow` object's ref. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {flow.idle && (
        <p className="font-mono text-[10px] text-muted-foreground">
          run → events arrive in real time
        </p>
      )}
    </Cell>
  );
}

// 7. STAKING — delegating → active
function StakingCell() {
  const flow = useFlow([
    ["building delegate", 600],
    ["wallet signing", 800],
    ["bonding", 700],
  ]);
  return (
    <Cell icon={CoinsIcon} label="staking · delegate" kind="write" flow={flow}>
      <p className="text-xs text-muted-foreground">
        Lets CSPR earn yield with a validator. Savings that pay interest.
      </p>
      <KV k="validator" v="01a7c8…validator" />
      <div className="grid grid-cols-2 gap-2">
        <Mini label="delegated" value={flow.done ? "500.00" : "—"} />
        <Mini label="apr est." value={flow.done ? "~9.8%" : "—"} accent />
      </div>
      {flow.done && <Confirmed label="status" value="bonded · active" />}
    </Cell>
  );
}

// 8. SUMMARY — product pipeline (static, it's the frame)
function SummaryCell() {
  const steps = [
    "meeting → bot records",
    "agent generates summary",
    "named key stores hash",
    "transfer + id pays",
    "sse releases delivery",
  ];
  return (
    <div className="flex flex-col rounded-[8px] border border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) p-1">
      <div className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-[10px] text-(--thread-accent-primary) uppercase tracking-wider">
        <ShieldCheckIcon className="size-3.5" />
        product pipeline
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
          100% native · zero smart contract
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
      {/* Header bar mono + run button */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          <Icon className="size-3.5" />
          {label}
        </span>
        <div className="flex items-center gap-2">
          {/* flow status */}
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

function KVInline({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        {k}
      </span>
      <span className="font-mono text-xs">{v}</span>
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

function Mini({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[5px] border bg-background p-2">
      <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span
        className={`font-mono font-semibold text-sm tabular-nums ${
          accent ? "text-(--thread-accent-primary)" : ""
        }`}
      >
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

function Dashed() {
  return <div className="my-2 border-border border-t border-dashed" />;
}
