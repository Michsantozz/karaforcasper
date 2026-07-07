import { Assistant } from "@/features/assistant/ui/Assistant";
import { AppShell } from "@/features/auth/ui/AppShell";
import { LoginScreen } from "@/features/auth/ui/LoginScreen";
import { getSession } from "@/features/auth/model/session";

/**
 * Gated home: the chat consumes an LLM and exposes on-chain tools, so it
 * requires sign in (/api/chat also rejects without a session — defense in
 * depth). Without a session, shows the sign-in screen; with a session, the
 * chat + auth/multisig shortcut.
 */
export default async function Home() {
  const session = await getSession();

  if (!session?.user?.id) {
    return <LoginScreen />;
  }

  return (
    <div className="md:pl-14">
      <AppShell />
      <Assistant />
    </div>
  );
}
