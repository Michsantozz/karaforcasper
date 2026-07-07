"use client";

import {
  CheckCircle2Icon,
  LoaderIcon,
  PenLineIcon,
  WalletIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { makeAssistantTool, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { connectWallet, signWithWallet } from "@/features/wallet/model/provider";
import { useTxMeta as useTxMetaQuery } from "@/features/multisig/model/queries";
import { cn } from "@/shared/lib/utils";

function short(hex: string) {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

// Human-readable tx metadata, fetched from /api/tx/:id to show the user what
// they're about to sign — independent of what the LLM passed along in args.
type TxMeta = {
  kind?: string;
  amountCspr?: string;
  from?: string;
  to?: string;
};

const KIND_LABEL: Record<string, string> = {
  transfer: "transfer",
  delegate: "delegation (staking)",
  undelegate: "undelegate",
  setup_multisig: "multisig setup",
};

// Tx metadata by txId, so the user ALWAYS sees what they're about to sign
// before the popup. txId is immutable → the data is cached forever by
// TanStack Query (useTxMetaQuery), so reopening the same card doesn't refetch.
function useTxMeta(txId: string | undefined): TxMeta | null {
  return useTxMetaQuery<TxMeta>(txId).data ?? null;
}

// ---------------------------------------------------------------------------
// connect_wallet — frontend tool. `execute` runs in the browser when the
// model calls it: it opens the extension popup (which is the user's own
// confirmation) and returns { connected, activeKey } to the model. `render`
// only shows the state. `execute` is REQUIRED for the tool to be sent to the
// server: assistant-ui's toToolsJSONSchema discards frontend tools without execute.
// ---------------------------------------------------------------------------

type ConnectResult = {
  connected: boolean;
  activeKey: string | null;
  error?: string;
};

function ConnectWalletCard({
  status,
  result,
}: ToolCallMessagePartProps<Record<string, never>, ConnectResult>) {
  if (status.type === "running")
    return <ToolCard icon={WalletIcon} label="connect wallet" running meta="waiting for popup" />;
  if (!result) return null;
  return result.connected ? (
    <ToolCard icon={CheckCircle2Icon} label="connect wallet" tone="success" meta="connected">
      <Row k="account" v={short(result.activeKey ?? "")} />
    </ToolCard>
  ) : (
    <ToolCard icon={XCircleIcon} label="connect wallet" tone="risk" meta="failed">
      <WalletError error={result.error ?? "not connected"} />
    </ToolCard>
  );
}

export const ConnectWalletTool = makeAssistantTool<Record<string, never>, ConnectResult>({
  toolName: "connect_wallet",
  type: "frontend",
  description:
    "Connects the user's Casper Wallet (opens the extension popup in the browser). Use when you need the user's address/account or before requesting a signature. Returns { connected, activeKey }.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => connectWallet(),
  render: ConnectWalletCard,
});

// ---------------------------------------------------------------------------
// sign_with_wallet — frontend tool. `execute` opens the signing popup with
// the transactionJson (built by prepare_user_transfer) and returns the
// signatureHex. The agent then calls broadcast_signed_tx on the server.
// ---------------------------------------------------------------------------

type SignArgs = {
  /** Short tx ID in the store (preferred — avoids passing giant JSON through the LLM). */
  txId?: string;
  /** Tx JSON directly (fallback for small txs). */
  transactionJson?: string;
  signerPublicKeyHex: string;
  amountCspr?: string;
  to?: string;
};

// Resolves the tx JSON: from the store (by txId) or directly. txId is
// preferred because large JSON (session/wasm) gets corrupted when passed as
// a tool argument through the LLM.
async function resolveTransactionJson(args: SignArgs): Promise<string | null> {
  if (args.txId) {
    try {
      const res = await fetch(`/api/tx/${args.txId}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { transactionJson?: string };
      return data.transactionJson ?? null;
    } catch {
      return null;
    }
  }
  return args.transactionJson ?? null;
}

type SignResult = {
  signed: boolean;
  signatureHex: string | null;
  signerPublicKeyHex: string;
  error?: string;
};

function SignWithWalletCard({
  args,
  status,
  result,
}: ToolCallMessagePartProps<SignArgs, SignResult>) {
  // Fetches the tx metadata (amount/to/from/kind) to ALWAYS show what the
  // user is about to sign, even when the LLM doesn't pass amount/to in args.
  const txMeta = useTxMeta(args.txId);
  if (status.type === "running") {
    const amount = args.amountCspr ?? txMeta?.amountCspr;
    const to = args.to ?? txMeta?.to;
    const from = txMeta?.from;
    const kindLabel = txMeta?.kind ? KIND_LABEL[txMeta.kind] ?? txMeta.kind : null;
    return (
      <ToolCard icon={PenLineIcon} label="sign tx" running meta="awaiting signature">
        <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
          You are about to sign
          {kindLabel ? ` a ${kindLabel}` : " this transaction"}. Check the
          details before approving in the wallet popup.
        </p>
        {(amount || to || from) && (
          <div className="mt-1.5 flex flex-col gap-1.5 border-t border-dashed border-border pt-2">
            {amount && <Row k="amount" v={`${amount} CSPR`} />}
            {from && <Row k="from" v={short(from)} />}
            {to && <Row k="to" v={short(to)} />}
          </div>
        )}
      </ToolCard>
    );
  }
  if (!result) return null;
  return result.signed ? (
    <ToolCard icon={CheckCircle2Icon} label="sign tx" tone="success" meta="signed">
      <Row k="signature" v={short(result.signatureHex ?? "")} />
    </ToolCard>
  ) : (
    <ToolCard icon={XCircleIcon} label="sign tx" tone="risk" meta="failed">
      <WalletError error={result.error ?? "signature cancelled"} />
    </ToolCard>
  );
}

export const SignWithWalletTool = makeAssistantTool<SignArgs, SignResult>({
  toolName: "sign_with_wallet",
  type: "frontend",
  description:
    "Asks the user to sign a transaction with the Casper Wallet (opens the signing popup). Receives transactionJson and signerPublicKeyHex from prepare_user_transfer. Returns { signed, signatureHex }. Then call broadcast_signed_tx to submit on-chain.",
  parameters: {
    type: "object",
    properties: {
      txId: { type: "string" },
      transactionJson: { type: "string" },
      signerPublicKeyHex: { type: "string" },
      amountCspr: { type: "string" },
      to: { type: "string" },
    },
    required: ["signerPublicKeyHex"],
    additionalProperties: false,
  },
  execute: async (args) => {
    const json = await resolveTransactionJson(args);
    if (!json)
      return {
        signed: false,
        signatureHex: null,
        signerPublicKeyHex: args.signerPublicKeyHex,
        error: "transaction not found (txId expired or missing)",
      };
    const out = await signWithWallet(json, args.signerPublicKeyHex);
    return { ...out, signerPublicKeyHex: args.signerPublicKeyHex };
  },
  render: SignWithWalletCard,
});

// ---------------------------------------------------------------------------
// Visual card — same style as the other Casper ToolUIs.
// ---------------------------------------------------------------------------

type Tone = "default" | "success" | "caution" | "risk";

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

// Displays the wallet error. When the extension isn't installed, shows a CTA
// with a download link — otherwise an external user won't know what to do.
function WalletError({ error }: { error: string }) {
  const notInstalled = /not installed/i.test(error);
  if (notInstalled)
    return (
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-sm text-foreground">
          Casper Wallet not detected.
        </span>
        <a
          href="https://www.casperwallet.io/download"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
        >
          <WalletIcon className="size-3" />
          install the extension and reload
        </a>
      </div>
    );
  return <Row k="error" v={error} />;
}
