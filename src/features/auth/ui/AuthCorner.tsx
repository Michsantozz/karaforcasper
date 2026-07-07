"use client";

import Link from "next/link";
import { UsersIcon, LogOutIcon, LogInIcon, LoaderIcon } from "lucide-react";
import { useSession, signIn, signOut } from "@/features/auth/model/auth-client";

/**
 * Canto de autenticação na home. O chat permanece público (qualquer um conversa
 * com o agente), mas as ações on-chain/multisig exigem login — então o estado de
 * auth fica visível e o acesso ao dashboard é gateado: sem sessão, o botão vira
 * "entrar"; com sessão, mostra o e-mail + atalho ao /multisig + sair.
 */
export function AuthCorner() {
  const { data: session, isPending } = useSession();

  return (
    <div className="fixed right-4 bottom-4 z-50 flex items-center gap-2">
      {isPending ? (
        <span className="flex items-center gap-1.5 rounded-[6px] border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground shadow-sm">
          <LoaderIcon className="size-3.5 animate-spin" />
          …
        </span>
      ) : session?.user ? (
        <>
          <Link
            href="/multisig"
            className="flex items-center gap-1.5 rounded-[6px] border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
          >
            <UsersIcon className="size-3.5" />
            multisig
          </Link>
          <button
            type="button"
            onClick={() => signOut()}
            className="flex items-center gap-1.5 rounded-[6px] border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
            aria-label="sair"
            title={session.user.email ?? "sair"}
          >
            <LogOutIcon className="size-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() =>
            // Volta para a página atual após o login, não força ir ao /multisig.
            signIn.social({
              provider: "google",
              callbackURL:
                typeof window !== "undefined"
                  ? window.location.pathname
                  : "/",
            })
          }
          className="flex items-center gap-1.5 rounded-[6px] border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
          aria-label="entrar com Google"
        >
          <LogInIcon className="size-3.5" />
          entrar
        </button>
      )}
    </div>
  );
}
