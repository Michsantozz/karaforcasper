import { Assistant } from "@/features/assistant/ui/Assistant";
import { AppShell } from "@/features/auth/ui/AppShell";
import { LoginScreen } from "@/features/auth/ui/LoginScreen";
import { getSession } from "@/features/auth/model/session";

/**
 * Home gateada: o chat consome LLM e expõe tools on-chain, então exige login
 * (o /api/chat também rejeita sem sessão — defesa em profundidade). Sem sessão,
 * mostra a tela de entrada; com sessão, o chat + atalho de auth/multisig.
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
