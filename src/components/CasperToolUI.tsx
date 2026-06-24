"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge } from "@/components/ui/badge";

function short(hex: string) {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

// ToolUI da carteira do agente.
export const WalletToolUI = makeAssistantToolUI<
  Record<string, never>,
  { publicKey: string; balanceCspr: string }
>({
  toolName: "get_agent_wallet",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard label="Consultando carteira do agente…" />;
    if (!result) return null;
    return (
      <ToolCard label="Carteira do agente">
        <Row k="Endereço" v={short(result.publicKey)} />
        <Row k="Saldo" v={`${result.balanceCspr} CSPR`} />
      </ToolCard>
    );
  },
});

// ToolUI de consulta de saldo.
export const BalanceToolUI = makeAssistantToolUI<
  { publicKeyHex: string },
  { balanceCspr: string }
>({
  toolName: "get_balance",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return <ToolCard label={`Consultando saldo de ${short(args.publicKeyHex)}…`} />;
    if (!result) return null;
    return (
      <ToolCard label="Saldo consultado">
        <Row k={short(args.publicKeyHex)} v={`${result.balanceCspr} CSPR`} />
      </ToolCard>
    );
  },
});

// ToolUI da transferência on-chain — mostra hash + link do explorer.
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
        <ToolCard label={`Enviando ${args.amountCspr} CSPR para ${short(args.toPublicKeyHex)}…`} />
      );
    if (!result) return null;
    return (
      <ToolCard label="Transferência confirmada on-chain" tone="success">
        <Row k="Valor" v={`${result.amountCspr} CSPR`} />
        <Row k="Para" v={short(result.to)} />
        <Row k="Rede" v={result.chainName} />
        <a
          href={result.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex text-sm font-medium text-primary underline underline-offset-4"
        >
          Ver no explorer ↗
        </a>
      </ToolCard>
    );
  },
});

function ToolCard({
  label,
  tone = "default",
  children,
}: {
  label: string;
  tone?: "default" | "success";
  children?: React.ReactNode;
}) {
  return (
    <div className="my-2 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant={tone === "success" ? "secondary" : "outline"}>
          {tone === "success" ? "✅ Casper" : "Casper"}
        </Badge>
        <span className="text-sm font-medium">{label}</span>
      </div>
      {children && <div className="flex flex-col gap-1 text-sm">{children}</div>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
