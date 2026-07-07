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
    // After a frontend tool (connect_wallet/sign_with_wallet) returns its
    // result, automatically resend to the agent so it continues the flow
    // (e.g. prepare → sign → broadcast) without needing a new message.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* ToolUIs registered on the provider — render the agent's tool-calls */}
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
      {/* Meetings + connected calendar (Recall/Calendar) — reuses the cards
          from MeetingAssistant. assistantAgent has these tools; without
          registration, list_calendar_events / summarize_meeting / etc. fall
          back to raw JSON. */}
      <MeetingToolUIs />
      {/* Clickable calendar in the chat — user picks the day, agent continues. */}
      <PickDateTool />
      {/* Connect Google Calendar via chat (button → OAuth popup → polling). */}
      <ConnectCalendarTool />
      <div className="h-dvh">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}
