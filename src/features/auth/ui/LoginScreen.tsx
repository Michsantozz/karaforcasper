"use client";

import { useEffect, useState } from "react";
import { SparklesIcon, LoaderIcon, MailIcon, KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import { signIn, authClient } from "@/features/auth/model/auth-client";

/**
 * Home sign-in screen. The chat (LLM + meeting tools) requires sign in;
 * without a session the user sees this. Three sign-in methods (Tier 1):
 *  - Google (social OAuth)
 *  - Magic link (passwordless email, via Resend)
 *  - Email + password (with signup and "forgot password")
 */

type Mode = "magic" | "password";

// Error messages returned by better-auth on magic link verification
// (redirect → errorCallbackURL with ?error=). Without this an expired token
// lands on the home page with no feedback at all.
const AUTH_ERROR_MSG: Record<string, string> = {
  INVALID_TOKEN: "Invalid or already used link. Request a new one below.",
  EXPIRED_TOKEN: "Link expired. Request a new one below.",
  failed_to_create_user: "Could not create the account. Please try again.",
  failed_to_create_session: "Failed to start the session. Please try again.",
};

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>("magic");

  // A failed magic link verification comes back here with ?error=. Shows the
  // toast and clears the query so it doesn't repeat on navigate/reload.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (!error) return;
    toast.error(AUTH_ERROR_MSG[error] ?? "Failed to sign in. Please try again.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-[10px] border bg-background">
          <SparklesIcon className="size-6 text-(--thread-accent-primary)" />
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">Casper Agent</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Your AI meeting assistant: schedule, record, transcribe, and
          summarize your meetings. Sign in to talk to the agent.
        </p>
      </div>

      <div className="flex w-full flex-col gap-4 rounded-[12px] border bg-background p-5">
        {/* Google */}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => signIn.social({ provider: "google", callbackURL: "/" })}
        >
          Sign in with Google
        </Button>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            or
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Magic link / password switcher */}
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
            label="Password"
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
      // An invalid/expired token on verification redirects back to home with
      // ?error=; LoginScreen reads it and shows the toast. Without this the
      // error is swallowed.
      errorCallbackURL: "/",
    });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Failed to send the link.");
      return;
    }
    setSent(true);
    toast.success("Link sent! Check your email.");
  }

  if (sent) {
    return (
      <p className="rounded-[8px] border bg-(--thread-accent-primary-soft)/30 px-3 py-4 text-center text-sm text-foreground">
        We sent an access link to <strong>{email}</strong>. Open the email and
        click it to sign in.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <Field
        type="email"
        placeholder="you@email.com"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Button type="submit" className="w-full" disabled={busy || !email}>
        {busy ? <Spinner /> : "Send access link"}
      </Button>
    </form>
  );
}

/* ── Email + password ──────────────────────────────────────────────────── */

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
      if (error) return toast.error(error.message ?? "Sign-up failed.");
      toast.success("Account created! Signing in…");
      window.location.href = "/";
      return;
    }

    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: "/",
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Invalid email or password.");
    window.location.href = "/";
  }

  async function forgot() {
    if (!email) return toast.error("Enter your email first.");
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    if (error) return toast.error(error.message ?? "Failed to send.");
    toast.success("If the email exists, we sent a reset link.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      {isSignup && (
        <Field
          type="text"
          placeholder="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
        />
      )}
      <Field
        type="email"
        placeholder="you@email.com"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Field
        type="password"
        placeholder="Password"
        value={password}
        onChange={setPassword}
        autoComplete={isSignup ? "new-password" : "current-password"}
      />
      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? <Spinner /> : isSignup ? "Sign up" : "Sign in"}
      </Button>

      <div className="flex items-center justify-between pt-0.5">
        <button
          type="button"
          onClick={() => setIsSignup((v) => !v)}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          {isSignup ? "Already have an account" : "Sign up"}
        </button>
        {!isSignup && (
          <button
            type="button"
            onClick={forgot}
            className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            Forgot password
          </button>
        )}
      </div>
    </form>
  );
}

/* ── primitives ──────────────────────────────────────────────────────── */

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
