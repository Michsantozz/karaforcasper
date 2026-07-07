import { MeetingDetail } from "@/features/meetings";
import { AppShell } from "@/features/auth/ui/AppShell";

// Detalhe de uma reunião: player + transcrição karaoke + notas de IA.
// Rota: /meetings/:botId
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
