"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { KeyRoundIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { authClient } from "@/features/auth/model/auth-client";

/**
 * Página de redefinição de senha. O link do e-mail (sendResetPassword → Resend)
 * cai aqui com ?token=. O usuário define a nova senha; em sucesso, volta à home.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return toast.error("Link inválido ou expirado.");
    if (password.length < 8)
      return toast.error("A senha precisa ter ao menos 8 caracteres.");
    if (password !== confirm) return toast.error("As senhas não conferem.");

    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Falha ao redefinir.");
    toast.success("Senha redefinida! Faça login.");
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-[10px] border bg-background">
          <KeyRoundIcon className="size-6 text-(--thread-accent-primary)" />
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">Nova senha</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Defina uma nova senha para sua conta.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex w-full flex-col gap-2.5 rounded-[12px] border bg-background p-5"
      >
        <input
          type="password"
          placeholder="Nova senha (mín. 8 caracteres)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className="w-full rounded-[8px] border bg-background px-3 py-2 text-sm outline-none focus:border-(--thread-accent-primary)"
        />
        <input
          type="password"
          placeholder="Confirme a nova senha"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="w-full rounded-[8px] border bg-background px-3 py-2 text-sm outline-none focus:border-(--thread-accent-primary)"
        />
        <Button type="submit" className="w-full" disabled={busy || !token}>
          {busy ? (
            <LoaderIcon className="size-4 animate-spin [animation-duration:0.6s]" />
          ) : (
            "Redefinir senha"
          )}
        </Button>
      </form>
    </main>
  );
}
