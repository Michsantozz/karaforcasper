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

// Metadados legíveis da tx, buscados em /api/tx/:id para mostrar ao usuário o
// que ele está prestes a assinar — independente do que o LLM repassou em args.
type TxMeta = {
  kind?: string;
  amountCspr?: string;
  from?: string;
  to?: string;
};

const KIND_LABEL: Record<string, string> = {
  transfer: "transferência",
  delegate: "delegação (staking)",
  undelegate: "resgate (undelegate)",
  setup_multisig: "configuração multisig",
};

// Metadados da tx pelo txId, para o usuário SEMPRE ver o que vai assinar antes
// do popup. O txId é imutável → o dado é cacheado forever pelo TanStack Query
// (useTxMetaQuery), então reabrir o mesmo card não refaz a chamada.
function useTxMeta(txId: string | undefined): TxMeta | null {
  return useTxMetaQuery<TxMeta>(txId).data ?? null;
}

// ---------------------------------------------------------------------------
// connect_wallet — frontend tool. O `execute` roda no browser quando o modelo
// chama: abre o popup da extensão (que é a própria confirmação do usuário) e
// devolve { connected, activeKey } ao modelo. `render` só mostra o estado.
// O `execute` é OBRIGATÓRIO para a tool ser enviada ao servidor: o
// toToolsJSONSchema do assistant-ui descarta frontend tools sem execute.
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
    return <ToolCard icon={WalletIcon} label="connect wallet" running meta="aguardando popup" />;
  if (!result) return null;
  return result.connected ? (
    <ToolCard icon={CheckCircle2Icon} label="connect wallet" tone="success" meta="connected">
      <Row k="account" v={short(result.activeKey ?? "")} />
    </ToolCard>
  ) : (
    <ToolCard icon={XCircleIcon} label="connect wallet" tone="risk" meta="failed">
      <WalletError error={result.error ?? "não conectado"} />
    </ToolCard>
  );
}

export const ConnectWalletTool = makeAssistantTool<Record<string, never>, ConnectResult>({
  toolName: "connect_wallet",
  type: "frontend",
  description:
    "Conecta a Casper Wallet do usuário (abre o popup da extensão no navegador). Use quando precisar do endereço/conta do usuário ou antes de pedir uma assinatura. Retorna { connected, activeKey }.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => connectWallet(),
  render: ConnectWalletCard,
});

// ---------------------------------------------------------------------------
// sign_with_wallet — frontend tool. `execute` abre o popup de assinatura com o
// transactionJson (montado por prepare_user_transfer) e devolve a signatureHex.
// O agente então chama broadcast_signed_tx no servidor.
// ---------------------------------------------------------------------------

type SignArgs = {
  /** ID curto da tx no store (preferido — evita passar JSON gigante pelo LLM). */
  txId?: string;
  /** JSON da tx direto (fallback para txs pequenas). */
  transactionJson?: string;
  signerPublicKeyHex: string;
  amountCspr?: string;
  to?: string;
};

// Resolve o JSON da tx: do store (por txId) ou direto. txId é preferido porque
// JSON grande (session/wasm) corrompe ao trafegar como argumento de tool no LLM.
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
  // Busca os metadados da tx (amount/to/from/kind) para mostrar SEMPRE o que o
  // usuário vai assinar, mesmo quando o LLM não repassa amount/to em args.
  const txMeta = useTxMeta(args.txId);
  if (status.type === "running") {
    const amount = args.amountCspr ?? txMeta?.amountCspr;
    const to = args.to ?? txMeta?.to;
    const from = txMeta?.from;
    const kindLabel = txMeta?.kind ? KIND_LABEL[txMeta.kind] ?? txMeta.kind : null;
    return (
      <ToolCard icon={PenLineIcon} label="sign tx" running meta="aguardando assinatura">
        <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
          Você está prestes a assinar
          {kindLabel ? ` uma ${kindLabel}` : " esta transação"}. Confira os dados
          antes de aprovar no popup da carteira.
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
      <WalletError error={result.error ?? "assinatura cancelada"} />
    </ToolCard>
  );
}

export const SignWithWalletTool = makeAssistantTool<SignArgs, SignResult>({
  toolName: "sign_with_wallet",
  type: "frontend",
  description:
    "Pede ao usuário que assine uma transação com a Casper Wallet (abre o popup de assinatura). Recebe transactionJson e signerPublicKeyHex de prepare_user_transfer. Retorna { signed, signatureHex }. Em seguida chame broadcast_signed_tx para submeter on-chain.",
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
        error: "transação não encontrada (txId expirado ou ausente)",
      };
    const out = await signWithWallet(json, args.signerPublicKeyHex);
    return { ...out, signerPublicKeyHex: args.signerPublicKeyHex };
  },
  render: SignWithWalletCard,
});

// ---------------------------------------------------------------------------
// Card visual — mesmo estilo dos demais Casper ToolUIs.
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

// Exibe o erro da carteira. Quando a extensão não está instalada, mostra um CTA
// com link de download — caso contrário o usuário externo não sabe o que fazer.
function WalletError({ error }: { error: string }) {
  const notInstalled = /não instalada|not installed/i.test(error);
  if (notInstalled)
    return (
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-sm text-foreground">
          Casper Wallet não detectada.
        </span>
        <a
          href="https://www.casperwallet.io/download"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
        >
          <WalletIcon className="size-3" />
          instalar a extensão e recarregar
        </a>
      </div>
    );
  return <Row k="error" v={error} />;
}
