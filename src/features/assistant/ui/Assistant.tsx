"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Thread } from "@/shared/ui/assistant-ui/thread";
import {
  WalletToolUI,
  BalanceToolUI,
  TransferToolUI,
  QuoteToolUI,
  AnalyzeTradeToolUI,
} from "@/features/wallet/ui/CasperToolUI";
import {
  ConnectWalletTool,
  SignWithWalletTool,
} from "@/features/wallet/ui/WalletConnectToolUI";
import {
  NotarizeMeetingToolUI,
  VerifyMeetingToolUI,
  SetupMultisigToolUI,
  PrepareMultisigToolUI,
  AddSignatureToolUI,
  BroadcastMultisigToolUI,
} from "@/features/assistant/ui/MeetingChainToolUI";
import {
  PrepareMultisigRequestToolUI,
  GetSignatureRequestToolUI,
  ListMyPendingSignaturesToolUI,
} from "@/features/multisig/ui/MultisigRequestToolUI";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { PickDateTool } from "@/features/meetings/ui/PickDateToolUI";
import { ConnectCalendarTool } from "@/features/meetings/ui/CalendarConnectToolUI";

export function Assistant() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat" }),
    // Após uma frontend tool (connect_wallet/sign_with_wallet) devolver seu
    // resultado, reenvia automaticamente ao agente para que ele continue o
    // fluxo (ex.: prepare → sign → broadcast) sem precisar de nova mensagem.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* ToolUIs registradas no provider — renderizam as tool-calls do agente */}
      <WalletToolUI />
      <BalanceToolUI />
      <TransferToolUI />
      <QuoteToolUI />
      <AnalyzeTradeToolUI />
      <ConnectWalletTool />
      <SignWithWalletTool />
      <NotarizeMeetingToolUI />
      <VerifyMeetingToolUI />
      <SetupMultisigToolUI />
      <PrepareMultisigToolUI />
      <AddSignatureToolUI />
      <BroadcastMultisigToolUI />
      <PrepareMultisigRequestToolUI />
      <GetSignatureRequestToolUI />
      <ListMyPendingSignaturesToolUI />
      {/* Reuniões + agenda conectada (Recall/Calendar) — reusa os cards do
          MeetingAssistant. O assistantAgent tem essas tools; sem registro,
          list_calendar_events / summarize_meeting / etc. caem no JSON cru. */}
      <MeetingToolUIs />
      {/* Calendário clicável no chat — usuário escolhe o dia, agente continua. */}
      <PickDateTool />
      {/* Conectar Google Calendar pelo chat (botão → OAuth popup → polling). */}
      <ConnectCalendarTool />
      <div className="h-dvh">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}
