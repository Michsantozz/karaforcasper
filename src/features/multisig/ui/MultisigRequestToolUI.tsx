"use client";

import {
  UsersIcon,
  LinkIcon,
  InboxIcon,
  LoaderIcon,
  ExternalLinkIcon,
  type LucideIcon,
} from "lucide-react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { cn } from "@/shared/lib/utils";

function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

// Translates the raw API status into a readable label.
const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  ready: "ready for broadcast",
  broadcast: "broadcast",
  confirmed: "confirmed",
  completed: "completed",
  cancelled: "cancelled",
  expired: "expired",
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

type Signer = { publicKeyHex: string; label?: string };

// prepare_multisig_payment_request — creates the persisted request + link.
export const PrepareMultisigRequestToolUI = makeAssistantToolUI<
  unknown,
  {
    id: string;
    link: string;
    status: string;
    threshold: number;
    requiredSigners: Signer[];
    notified: number;
    amountCspr?: string;
    to?: string;
    description?: string | null;
  }
>({
  toolName: "prepare_multisig_payment_request",
  render: ({ result, status }) => {
    if (status.type === "running")
      return (
        <Card icon={UsersIcon} label="multisig request" running meta="creating" />
      );
    if (!result) return null;
    return (
      <Card
        icon={UsersIcon}
        label="multisig request"
        tone="success"
        meta={`${result.threshold} signatures`}
      >
        {result.description && <p className="text-sm">{result.description}</p>}
        {result.amountCspr && <Row k="amount" v={`${result.amountCspr} CSPR`} />}
        {result.to && <Row k="to" v={short(result.to)} />}
        <Row k="status" v={statusLabel(result.status)} />
        <Row k="notified" v={String(result.notified)} />
        <div className="mt-1 border-t border-dashed border-border pt-2" />
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          signers ({result.threshold} required)
        </span>
        {result.requiredSigners.map((s) => (
          <div
            key={s.publicKeyHex}
            className="flex items-center justify-between gap-3"
          >
            <span className="font-mono text-[11px] text-muted-foreground">
              {s.label ? `${s.label} · ` : ""}
              {short(s.publicKeyHex)}
            </span>
          </div>
        ))}
        <SignLink link={result.link} label="signing link" />
        <p className="font-mono text-[10px] text-muted-foreground">
          Share this link with the signers so they can sign from their own
          wallet.
        </p>
      </Card>
    );
  },
});

// get_signature_request — status/progress of a request.
export const GetSignatureRequestToolUI = makeAssistantToolUI<
  { id: string },
  {
    id: string;
    status: string;
    description: string | null;
    threshold: number;
    signed: string[];
    pending: string[];
    ready: boolean;
    link: string;
    transactionHash: string | null;
  }
>({
  toolName: "get_signature_request",
  render: ({ result, status }) => {
    if (status.type === "running")
      return (
        <Card icon={LinkIcon} label="signature request" running meta="querying" />
      );
    if (!result) return null;
    return (
      <Card
        icon={UsersIcon}
        label="signature request"
        tone={result.ready ? "success" : "caution"}
        meta={`${result.signed.length}/${result.threshold} signed`}
      >
        {result.description && (
          <p className="text-sm">{result.description}</p>
        )}
        <Row k="status" v={statusLabel(result.status)} />
        <div className="mt-1 border-t border-dashed border-border pt-2" />
        {result.signed.map((s) => (
          <div key={s} className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-muted-foreground">
              {short(s)}
            </span>
            <span className="font-mono text-[10px] text-(--thread-accent-primary)">
              signed ✓
            </span>
          </div>
        ))}
        {result.pending.map((s) => (
          <div key={s} className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-muted-foreground">
              {short(s)}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              pending
            </span>
          </div>
        ))}
        {result.ready && (
          <p className="pt-1 font-mono text-[11px] text-(--thread-accent-primary)">
            quorum reached — ready for broadcast
          </p>
        )}
        <SignLink link={result.link} label="open" />
      </Card>
    );
  },
});

// list_my_pending_signatures — "what do I need to sign?".
export const ListMyPendingSignaturesToolUI = makeAssistantToolUI<
  unknown,
  {
    pending: {
      id: string;
      description: string | null;
      status: string;
      signedCount: number;
      threshold: number;
      link: string;
    }[];
  }
>({
  toolName: "list_my_pending_signatures",
  render: ({ result, status }) => {
    if (status.type === "running")
      return (
        <Card icon={InboxIcon} label="pending signatures" running meta="fetching" />
      );
    if (!result) return null;
    return (
      <Card
        icon={InboxIcon}
        label="pending signatures"
        tone={result.pending.length ? "caution" : "default"}
        meta={`${result.pending.length} awaiting`}
      >
        {result.pending.length === 0 ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            nothing awaiting your signature
          </span>
        ) : (
          result.pending.map((p) => (
            <a
              key={p.id}
              href={p.link}
              className="flex items-center justify-between gap-3 rounded-[4px] px-1 py-1 hover:bg-muted/50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {p.description ?? p.id}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {p.signedCount}/{p.threshold} signed · {p.status}
                </p>
              </div>
              <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </a>
          ))
        )}
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
        : tone === "risk"
          ? "bg-(--thread-accent-secondary)"
          : "bg-muted-foreground";
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

function SignLink({ link, label }: { link: string; label: string }) {
  return (
    <>
      <div className="mt-2 border-t border-dashed border-border" />
      <a
        href={link}
        className="inline-flex items-center gap-1 pt-2 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
      >
        <LinkIcon className="size-3" />
        {label}
      </a>
    </>
  );
}
