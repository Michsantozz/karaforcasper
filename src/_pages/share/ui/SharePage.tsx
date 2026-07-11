import { PublicMeetingView } from "@/features/meetings";

// Public, read-only shared meeting. No AppShell/auth — reachable by anyone with
// the unguessable share token.
// Route: /share/:token
export async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicMeetingView token={token} />;
}
