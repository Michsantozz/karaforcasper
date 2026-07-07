import { MeetingAssistant } from "@/features/meetings/ui/MeetingAssistant";
import { AppShell } from "@/features/auth/ui/AppShell";

// Meeting agent chat. Login gate + bot control via conversation.
// Route: /meetings
export default function MeetingsPage() {
  return (
    <div className="md:pl-14">
      <AppShell />
      <MeetingAssistant />
    </div>
  );
}
