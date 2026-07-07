"use client";

import {
  ArrowRightLeftIcon,
  CircleDollarSignIcon,
  ExternalLinkIcon,
  GaugeIcon,
  LoaderIcon,
  RepeatIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { cn } from "@/shared/lib/utils";

function short(hex: string) {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

// MCP tools return { content: [{ type: "text", text: "<json|text>" }] }.
// Extracts the raw text from the first block.
function mcpText(result: unknown): string | null {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ?? null;
}

// ToolUI for the agent's wallet.
export const WalletToolUI = makeAssistantToolUI<
  Record<string, never>,
  { publicKey: string; balanceCspr: string }
>({
  toolName: "get_agent_wallet",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={WalletIcon} label="agent wallet" running />;
    if (!result) return null;
    return (
      <ToolCard icon={WalletIcon} label="agent wallet">
        <Row k="address" v={short(result.publicKey)} />
        <Row k="balance" v={`${result.balanceCspr} CSPR`} />
      </ToolCard>
    );
  },
});

// ToolUI for the balance query.
export const BalanceToolUI = makeAssistantToolUI<
  { publicKeyHex: string },
  { balanceCspr: string }
>({
  toolName: "get_balance",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={CircleDollarSignIcon} label="query balance" running />;
    if (!result) return null;
    return (
      <ToolCard icon={CircleDollarSignIcon} label="query balance">
        <Row k={short(args.publicKeyHex)} v={`${result.balanceCspr} CSPR`} />
      </ToolCard>
    );
  },
});

// ToolUI for the on-chain transfer — shows hash + explorer link.
export const TransferToolUI = makeAssistantToolUI<
  { toPublicKeyHex: string; amountCspr: number },
  {
    transactionHash: string;
    amountCspr: string;
    to: string;
    chainName: string;
    explorerUrl: string;
  }
>({
  toolName: "transfer_cspr",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return (
        <ToolCard
          icon={ArrowRightLeftIcon}
          label="transfer cspr"
          running
          meta={`${args.amountCspr} CSPR → ${short(args.toPublicKeyHex)}`}
        />
      );
    if (!result) return null;
    return (
      <ToolCard
        icon={ArrowRightLeftIcon}
        label="transfer cspr"
        tone="success"
        meta="confirmed on-chain"
      >
        <div className="flex items-center gap-1.5 rounded-[4px] bg-(--thread-accent-secondary)/10 px-2 py-1">
          <WalletIcon className="size-3 text-(--thread-accent-secondary)" />
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            agent wallet — paid by the agent, no signature needed from you
          </span>
        </div>
        <Row k="amount" v={`${result.amountCspr} CSPR`} />
        <Row k="to" v={short(result.to)} />
        <Row k="network" v={result.chainName} />
        <Row k="tx" v={short(result.transactionHash)} />
        <div className="mt-2 border-t border-dashed border-border" />
        <a
          href={result.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 pt-2 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
        >
          <ExternalLinkIcon className="size-3" />
          view on explorer
        </a>
      </ToolCard>
    );
  },
});

// MCP ToolUI — swap quote (csprTrade get_quote).
type QuoteResult = {
  amountInFormatted: string;
  amountOutFormatted: string;
  executionPrice: string;
  midPrice: string;
  priceImpact: string;
  recommendedSlippageBps: string;
  pathSymbols: string[];
  tokenInSymbol: string;
  tokenOutSymbol: string;
};

export const QuoteToolUI = makeAssistantToolUI<
  { token_in: string; token_out: string; amount: string },
  unknown
>({
  toolName: "get_quote",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return (
        <ToolCard
          icon={RepeatIcon}
          label="get quote"
          running
          meta={`${args.amount} ${args.token_in} → ${args.token_out}`}
        />
      );
    const text = mcpText(result);
    if (!text) return null;
    let q: QuoteResult;
    try {
      q = JSON.parse(text);
    } catch {
      return null;
    }
    const impact = Number.parseFloat(q.priceImpact);
    const tone = impactTone(impact);
    return (
      <ToolCard
        icon={RepeatIcon}
        label="get quote"
        tone={tone}
        meta={`impact ${q.priceImpact}%`}
      >
        <Row k="send" v={`${q.amountInFormatted} ${q.tokenInSymbol}`} />
        <Row k="receive" v={`${q.amountOutFormatted} ${q.tokenOutSymbol}`} />
        <Row k="exec price" v={q.executionPrice} />
        <Row k="mid price" v={q.midPrice} />
        <div className="mt-2 border-t border-dashed border-border" />
        <div className="flex items-center justify-between gap-4 pt-2">
          <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
            route
          </span>
          <span className="flex items-center gap-1">
            {q.pathSymbols.map((sym, i) => (
              <span key={`${sym}-${i}`} className="flex items-center gap-1">
                {i > 0 && (
                  <span aria-hidden className="font-mono text-[10px] text-muted-foreground">
                    →
                  </span>
                )}
                <span className="inline-flex items-center rounded-[5px] border bg-background px-1.5 py-0.5 font-mono text-[10px] text-(--thread-accent-primary)">
                  {sym}
                </span>
              </span>
            ))}
          </span>
        </div>
        <Row k="slippage" v={`${(Number(q.recommendedSlippageBps) / 100).toFixed(2)}%`} />
        <p className="pt-1 font-mono text-[10px] text-muted-foreground">
          Indicative quote — the price may vary until execution. Re-check if it
          takes a while.
        </p>
      </ToolCard>
    );
  },
});

// MCP ToolUI — trade analysis (csprTrade analyze_trade). Result is free text.
export const AnalyzeTradeToolUI = makeAssistantToolUI<
  { token_in: string; token_out: string; amount: string },
  unknown
>({
  toolName: "analyze_trade",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return (
        <ToolCard
          icon={GaugeIcon}
          label="analyze trade"
          running
          meta={`${args.amount} ${args.token_in} → ${args.token_out}`}
        />
      );
    const text = mcpText(result);
    if (!text) return null;
    const rec = /Recommendation:\s*([A-Z_]+)/i.exec(text)?.[1] ?? "";
    const tone = recommendationTone(rec);
    const metrics = parseAnalyzeMetrics(text);
    return (
      <ToolCard
        icon={GaugeIcon}
        label="analyze trade"
        tone={tone}
        meta={rec ? rec.toLowerCase().replace(/_/g, " ") : undefined}
      >
        {metrics.map(({ k, v }) => (
          <Row key={k} k={k} v={v} />
        ))}
      </ToolCard>
    );
  },
});

// Extracts "label: value" metrics from analyze_trade's emoji lines.
function parseAnalyzeMetrics(text: string): Array<{ k: string; v: string }> {
  const map: Array<[RegExp, string]> = [
    [/Price Impact:\s*([^\n]+)/i, "price impact"],
    [/Expected Slippage:\s*([^\n]+)/i, "slippage"],
    [/Expected Output:\s*([^\n]+)/i, "expected out"],
    [/Minimum Output:\s*([^\n]+)/i, "minimum out"],
  ];
  return map
    .map(([re, k]) => {
      const v = re.exec(text)?.[1]?.trim();
      return v ? { k, v } : null;
    })
    .filter((x): x is { k: string; v: string } => x !== null);
}

type Tone = "default" | "success" | "caution" | "risk";

// Severity by price impact: <1% ok, <3% caution, ≥3% risk.
function impactTone(impact: number): Tone {
  if (Number.isNaN(impact)) return "default";
  if (impact < 1) return "success";
  if (impact < 3) return "caution";
  return "risk";
}

function recommendationTone(rec: string): Tone {
  const r = rec.toUpperCase();
  if (r === "PROCEED") return "success";
  if (r === "CAUTION") return "caution";
  if (r === "HIGH_RISK" || r === "HIGHRISK") return "risk";
  return "default";
}

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
        : tone === "risk"
          ? "bg-(--thread-accent-secondary)"
          : "bg-(--thread-accent-secondary)";

  return (
    <div className="my-2 rounded-[8px] bg-(--thread-frame-outer) p-1">
      {/* Mono header bar */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          {running ? (
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
          ) : (
            <Icon className="size-3.5" />
          )}
          casper / {label}
        </span>
        {running ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 animate-pulse rounded-[1px]", accent)}
            />
            running
          </span>
        ) : (
          meta && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span aria-hidden className={cn("size-2 rounded-[1px]", accent)} />
              {meta}
            </span>
          )
        )}
      </div>

      {/* Inner card */}
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
