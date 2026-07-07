"use client";

import {
  AlertTriangleIcon,
  BadgeCheckIcon,
  ExternalLinkIcon,
  FileCheck2Icon,
  KeyRoundIcon,
  LoaderIcon,
  ShieldCheckIcon,
  UsersIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { cn } from "@/shared/lib/utils";

function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

// notarize_meeting — minutes anchored on-chain.
export const NotarizeMeetingToolUI = makeAssistantToolUI<
  { record: unknown },
  {
    meetingHash: string;
    transactionHash: string;
    notary: string;
    chainName: string;
    explorerUrl: string;
  }
>({
  toolName: "notarize_meeting",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <Card icon={FileCheck2Icon} label="notarize meeting" running meta="anchoring" />;
    if (!result) return null;
    return (
      <Card icon={ShieldCheckIcon} label="notarize meeting" tone="success" meta="on-chain">
        <Row k="meeting hash" v={short(result.meetingHash)} />
        <Row k="notary" v={short(result.notary)} />
        <Row k="network" v={result.chainName} />
        <Row k="tx" v={short(result.transactionHash)} />
        <ExplorerLink url={result.explorerUrl} />
      </Card>
    );
  },
});

// verify_meeting — checks minutes against the on-chain record.
export const VerifyMeetingToolUI = makeAssistantToolUI<
  { transactionHash: string; record?: unknown },
  {
    found: boolean;
    anchoredId: number | null;
    expectedId: number | null;
    recomputedHash: string | null;
    matches: boolean;
    transactionHash: string;
    explorerUrl: string;
  }
>({
  toolName: "verify_meeting",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <Card icon={BadgeCheckIcon} label="verify meeting" running meta="checking" />;
    if (!result) return null;
    const tone = result.matches ? "success" : result.found ? "caution" : "risk";
    const meta = result.matches
      ? "verified ✓"
      : result.found
        ? "mismatch"
        : "not found";
    return (
      <Card
        icon={result.matches ? BadgeCheckIcon : XCircleIcon}
        label="verify meeting"
        tone={tone}
        meta={meta}
      >
        {result.anchoredId !== null && <Row k="on-chain id" v={String(result.anchoredId)} />}
        {result.expectedId !== null && <Row k="expected id" v={String(result.expectedId)} />}
        {result.recomputedHash && <Row k="minutes hash" v={short(result.recomputedHash)} />}
        <ExplorerLink url={result.explorerUrl} />
      </Card>
    );
  },
});

// setup_multisig_account — configures the account as native multisig. Shows
// the steps to sign (in order) + the resulting config + a lockout warning.
type SetupResult = {
  primaryPublicKeyHex: string;
  steps: { label: string; txId: string }[];
  config: {
    primaryWeight: number;
    associatedKeys: { publicKeyHex: string; weight: number }[];
    deploymentThreshold: number;
    keyManagementThreshold: number;
  };
  chainName: string;
};

export const SetupMultisigToolUI = makeAssistantToolUI<unknown, SetupResult>({
  toolName: "setup_multisig_account",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <Card icon={KeyRoundIcon} label="setup multisig" running meta="building" />;
    if (!result) return null;
    return (
      <Card
        icon={KeyRoundIcon}
        label="setup multisig (native)"
        tone="caution"
        meta={`${result.steps.length} steps`}
      >
        <div className="flex items-start gap-1.5 rounded-[4px] bg-amber-500/10 p-2">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
            IRREVERSIBLE operation: changes the account on-chain. If the
            threshold exceeds the controllable weight, the account LOCKS
            permanently. Check the weights and the quorum below before
            signing each step. Use a test account.
          </span>
        </div>
        <div className="mt-1 border-t border-dashed border-border pt-2" />
        <Row k="primary account" v={short(result.primaryPublicKeyHex)} />
        <div className="mt-1 border-t border-dashed border-border pt-2" />
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          resulting quorum
        </span>
        <Row k="deployment" v={String(result.config.deploymentThreshold)} />
        <Row k="key mgmt" v={String(result.config.keyManagementThreshold)} />
        <Row
          k={`${short(result.primaryPublicKeyHex)} (primary)`}
          v={`weight ${result.config.primaryWeight}`}
        />
        {result.config.associatedKeys.map((a) => (
          <Row key={a.publicKeyHex} k={short(a.publicKeyHex)} v={`weight ${a.weight}`} />
        ))}
        <div className="mt-1 border-t border-dashed border-border pt-2" />
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          steps to sign (in order)
        </span>
        {result.steps.map((s, i) => (
          <div key={s.label} className="flex items-start gap-2">
            <span className="mt-0.5 font-mono text-[10px] text-(--thread-accent-primary)">
              {i + 1}.
            </span>
            <span className="font-mono text-[11px] text-foreground">{s.label}</span>
          </div>
        ))}
      </Card>
    );
  },
});

// Multisig state shared by prepare/add/broadcast.
type MultisigState = {
  transactionJson: string;
  from: string;
  to: string;
  amountCspr: string;
  signers: string[];
  threshold: number;
  signed: string[];
  pending: string[];
  ready: boolean;
  chainName: string;
};

function MultisigCard({ state }: { state: MultisigState }) {
  return (
    <Card
      icon={UsersIcon}
      label="multisig payment"
      tone={state.ready ? "success" : "caution"}
      meta={`${state.signed.length}/${state.threshold} signed`}
    >
      <Row k="amount" v={`${state.amountCspr} CSPR`} />
      <Row k="from" v={short(state.from)} />
      <Row k="to" v={short(state.to)} />
      <div className="mt-1 border-t border-dashed border-border pt-2" />
      {state.signers.map((s) => {
        const done = state.signed.includes(s.toLowerCase());
        return (
          <div key={s} className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-muted-foreground">
              {short(s)}
            </span>
            <span
              className={cn(
                "font-mono text-[10px]",
                done ? "text-(--thread-accent-primary)" : "text-muted-foreground",
              )}
            >
              {done ? "signed ✓" : "pending"}
            </span>
          </div>
        );
      })}
      {state.ready && (
        <p className="pt-1 font-mono text-[11px] text-(--thread-accent-primary)">
          quorum reached — ready to broadcast
        </p>
      )}
    </Card>
  );
}

export const PrepareMultisigToolUI = makeAssistantToolUI<unknown, MultisigState>({
  toolName: "prepare_multisig_payment",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <Card icon={UsersIcon} label="multisig payment" running meta="building" />;
    if (!result) return null;
    return <MultisigCard state={result} />;
  },
});

export const AddSignatureToolUI = makeAssistantToolUI<unknown, MultisigState>({
  toolName: "add_signature",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <Card icon={UsersIcon} label="multisig signature" running meta="adding" />;
    if (!result) return null;
    return <MultisigCard state={result} />;
  },
});

export const BroadcastMultisigToolUI = makeAssistantToolUI<
  { transactionJson: string },
  {
    transactionHash: string;
    explorerUrl: string;
    amountCspr?: string;
    to?: string;
  }
>({
  toolName: "broadcast_multisig",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <Card icon={UsersIcon} label="multisig broadcast" running meta="submitting" />;
    if (!result) return null;
    return (
      <Card icon={ShieldCheckIcon} label="multisig broadcast" tone="success" meta="on-chain">
        {result.amountCspr && <Row k="amount" v={`${result.amountCspr} CSPR`} />}
        {result.to && <Row k="to" v={short(result.to)} />}
        <Row k="tx" v={short(result.transactionHash)} />
        <ExplorerLink url={result.explorerUrl} />
      </Card>
    );
  },
});

// --- Shared visual card (same style as the other Casper ToolUIs) ---

type Tone = "default" | "success" | "caution" | "risk";

function Card({
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
      : tone === "caution"
        ? "bg-amber-500"
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
          casper / {label}
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
      <span className="font-mono text-sm tabular-nums">{v}</span>
    </div>
  );
}

function ExplorerLink({ url }: { url: string }) {
  return (
    <>
      <div className="mt-2 border-t border-dashed border-border" />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 pt-2 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
      >
        <ExternalLinkIcon className="size-3" />
        view on explorer
      </a>
    </>
  );
}
