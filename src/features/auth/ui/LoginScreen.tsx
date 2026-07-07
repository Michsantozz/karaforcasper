"use client";

import { useState } from "react";
import { SparklesIcon, LoaderIcon, MailIcon, KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import { signIn, authClient } from "@/features/auth/model/auth-client";

/**
 * Tela de entrada da home. O chat (LLM + tools on-chain) exige login; sem sessão
 * o usuário vê isto. Três formas de login (Tier 1):
 *  - Google (OAuth social)
 *  - Magic link (e-mail sem senha, via Resend)
 *  - E-mail + senha (com signup e "esqueci a senha")
 */

type Mode = "magic" | "password";

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>("magic");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-[10px] border bg-background">
          <SparklesIcon className="size-6 text-(--thread-accent-primary)" />
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">Casper Agent</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Agente autônomo na Casper Network: pagamentos, multisig, notarização de
          atas e mais. Entre para conversar com o agente.
        </p>
      </div>

      <div className="flex w-full flex-col gap-4 rounded-[12px] border bg-background p-5">
        {/* Google */}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => signIn.social({ provider: "google", callbackURL: "/" })}
        >
          Entrar com Google
        </Button>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            ou
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Alternador magic link / senha */}
        <div className="flex rounded-[8px] border p-0.5">
          <TabButton
            active={mode === "magic"}
            onClick={() => setMode("magic")}
            icon={MailIcon}
            label="Magic link"
          />
          <TabButton
            active={mode === "password"}
            onClick={() => setMode("password")}
            icon={KeyRoundIcon}
            label="Senha"
          />
        </div>

        {mode === "magic" ? <MagicLinkForm /> : <PasswordForm />}
      </div>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MailIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-[6px] py-1.5 font-mono text-xs transition-colors",
        active
          ? "bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/* ── Magic link ──────────────────────────────────────────────────────── */

function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: "/",
    });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Falha ao enviar o link.");
      return;
    }
    setSent(true);
    toast.success("Link enviado! Confira seu e-mail.");
  }

  if (sent) {
    return (
      <p className="rounded-[8px] border bg-(--thread-accent-primary-soft)/30 px-3 py-4 text-center text-sm text-foreground">
        Enviamos um link de acesso para <strong>{email}</strong>. Abra o e-mail e
        clique para entrar.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <Field
        type="email"
        placeholder="voce@email.com"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Button type="submit" className="w-full" disabled={busy || !email}>
        {busy ? <Spinner /> : "Enviar link de acesso"}
      </Button>
    </form>
  );
}

/* ── E-mail + senha ──────────────────────────────────────────────────── */

function PasswordForm() {
  const [isSignup, setIsSignup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);

    if (isSignup) {
      const { error } = await authClient.signUp.email({
        name: name || email.split("@")[0],
        email,
        password,
        callbackURL: "/",
      });
      setBusy(false);
      if (error) return toast.error(error.message ?? "Falha no cadastro.");
      toast.success("Conta criada! Entrando…");
      window.location.href = "/";
      return;
    }

    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: "/",
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "E-mail ou senha inválidos.");
    window.location.href = "/";
  }

  async function forgot() {
    if (!email) return toast.error("Informe seu e-mail primeiro.");
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    if (error) return toast.error(error.message ?? "Falha ao enviar.");
    toast.success("Se o e-mail existir, enviamos um link de redefinição.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      {isSignup && (
        <Field
          type="text"
          placeholder="Seu nome"
          value={name}
          onChange={setName}
          autoComplete="name"
        />
      )}
      <Field
        type="email"
        placeholder="voce@email.com"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Field
        type="password"
        placeholder="Senha"
        value={password}
        onChange={setPassword}
        autoComplete={isSignup ? "new-password" : "current-password"}
      />
      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? <Spinner /> : isSignup ? "Criar conta" : "Entrar"}
      </Button>

      <div className="flex items-center justify-between pt-0.5">
        <button
          type="button"
          onClick={() => setIsSignup((v) => !v)}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          {isSignup ? "Já tenho conta" : "Criar conta"}
        </button>
        {!isSignup && (
          <button
            type="button"
            onClick={forgot}
            className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            Esqueci a senha
          </button>
        )}
      </div>
    </form>
  );
}

/* ── primitivos ──────────────────────────────────────────────────────── */

function Field({
  type,
  placeholder,
  value,
  onChange,
  autoComplete,
}: {
  type: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      className="w-full rounded-[8px] border bg-background px-3 py-2 text-sm outline-none focus:border-(--thread-accent-primary)"
    />
  );
}

function Spinner() {
  return (
    <LoaderIcon className="size-4 animate-spin [animation-duration:0.6s]" />
  );
}
