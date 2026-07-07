import { MeetingDetail } from "@/features/meetings";
import { AppShell } from "@/features/auth/ui/AppShell";

// Meeting detail: player + karaoke transcript + AI notes.
// Route: /meetings/:botId
export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="md:pl-14">
      <AppShell />
      <MeetingDetail botId={botId} />
    </div>
  );
}
