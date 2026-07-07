"use client";

import Link from "next/link";
import { UsersIcon, LogOutIcon, LogInIcon, LoaderIcon } from "lucide-react";
import { useSession, signIn, signOut } from "@/features/auth/model/auth-client";

/**
 * Auth corner on the home page. The chat stays public (anyone can talk to the
 * agent), but on-chain/multisig actions require sign in — so the auth state
 * stays visible and dashboard access is gated: without a session, the button
 * becomes "sign in"; with a session, it shows the email + shortcut to
 * /multisig + sign out.
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
            aria-label="sign out"
            title={session.user.email ?? "sign out"}
          >
            <LogOutIcon className="size-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() =>
            // Returns to the current page after sign-in, doesn't force /multisig.
            signIn.social({
              provider: "google",
              callbackURL:
                typeof window !== "undefined"
                  ? window.location.pathname
                  : "/",
            })
          }
          className="flex items-center gap-1.5 rounded-[6px] border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
          aria-label="sign in with Google"
        >
          <LogInIcon className="size-3.5" />
          sign in
        </button>
      )}
    </div>
  );
}
