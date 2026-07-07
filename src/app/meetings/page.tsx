import { MeetingAssistant } from "@/features/meetings/ui/MeetingAssistant";
import { AppShell } from "@/features/auth/ui/AppShell";

// Chat do agente de reuniões. Gate de login + controle de bots via conversa.
// Rota: /meetings
export default function MeetingsPage() {
  return (
    <div className="md:pl-14">
      <AppShell />
      <MeetingAssistant />
    </div>
  );
}
