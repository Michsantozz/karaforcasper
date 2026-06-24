"use client";

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AuiIf,
  makeAssistantToolUI,
} from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";

// Tool UI: render do resultado da transferência on-chain.
const TransferToolUI = makeAssistantToolUI<
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
        <div style={card}>
          Enviando {args.amountCspr} CSPR para {short(args.toPublicKeyHex)}…
        </div>
      );
    if (result)
      return (
        <div style={card}>
          ✅ Transferiu <b>{result.amountCspr} CSPR</b> para{" "}
          {short(result.to)} em <code>{result.chainName}</code>
          <br />
          <a href={result.explorerUrl} target="_blank" rel="noreferrer">
            Ver no explorer ↗
          </a>
        </div>
      );
    return null;
  },
});

export function Assistant() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat" }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TransferToolUI />
      <ThreadPrimitive.Root style={{ display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 760, margin: "0 auto" }}>
        <ThreadPrimitive.Viewport style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div style={{ opacity: 0.6 }}>
              Pergunte o saldo da carteira ou peça para transferir CSPR no Testnet.
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages
            components={{
              UserMessage: () => (
                <MessagePrimitive.Root style={{ alignSelf: "flex-end", background: "#2563eb", color: "#fff", padding: "8px 12px", borderRadius: 12, maxWidth: "80%" }}>
                  <MessagePrimitive.Parts />
                </MessagePrimitive.Root>
              ),
              AssistantMessage: () => (
                <MessagePrimitive.Root style={{ alignSelf: "flex-start", background: "#f1f5f9", color: "#0f172a", padding: "8px 12px", borderRadius: 12, maxWidth: "80%" }}>
                  <MessagePrimitive.Parts />
                </MessagePrimitive.Root>
              ),
            }}
          />
        </ThreadPrimitive.Viewport>

        <ComposerPrimitive.Root style={{ display: "flex", gap: 8, padding: 16, borderTop: "1px solid #e2e8f0" }}>
          <ComposerPrimitive.Input
            placeholder="Fale com o Casper Agent…"
            style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1" }}
          />
          <AuiIf condition={(s) => !s.thread.isRunning}>
            <ComposerPrimitive.Send style={btn}>Enviar</ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.isRunning}>
            <ComposerPrimitive.Cancel style={btn}>Parar</ComposerPrimitive.Cancel>
          </AuiIf>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

const card: React.CSSProperties = {
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: 10,
  padding: 12,
  fontSize: 14,
};
const btn: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "none",
  background: "#2563eb",
  color: "#fff",
  cursor: "pointer",
};

function short(hex: string) {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}
