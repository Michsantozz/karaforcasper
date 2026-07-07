"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquareIcon,
  VideoIcon,
  PenLineIcon,
  SunIcon,
  MoonIcon,
  LogOutIcon,
  LogInIcon,
  MenuIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/shared/lib/utils";
import { useSession, signIn, signOut } from "@/features/auth/model/auth-client";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/shared/ui/tooltip";
import { OnboardingDialog } from "@/features/auth/ui/OnboardingDialog";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Combina rotas filhas (ex.: /multisig/[id]) para o estado ativo. */
  match: (path: string) => boolean;
};

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Chat",
    icon: MessageSquareIcon,
    match: (p) => p === "/",
  },
  {
    href: "/meetings",
    label: "Reuniões",
    icon: VideoIcon,
    match: (p) => p.startsWith("/meetings"),
  },
  {
    href: "/multisig",
    label: "Assinaturas",
    icon: PenLineIcon,
    match: (p) => p.startsWith("/multisig") || p.startsWith("/sign"),
  },
];

/**
 * Shell de navegação global das telas autenticadas. Antes cada página era uma
 * ilha sem como descobrir as outras; agora há um rail fixo à esquerda (desktop)
 * e um menu flutuante (mobile) que liga Chat ⇆ Reuniões ⇆ Multisig, além de
 * theme toggle e ação de sair. É auto-contido (position: fixed) e não envolve o
 * conteúdo — as páginas só adicionam `md:pl-14` para não ficar sob o rail.
 */
export function AppShell() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Fecha o menu mobile ao navegar. Sincronizar com `pathname` num effect é o
  // caminho correto — não dá pra derivar em render sem perder o toggle manual.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <>
      {/* Rail desktop */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-14 flex-col items-center border-r bg-background py-3 md:flex">
        <Link
          href="/"
          aria-label="Casper Agent"
          className="mb-2 flex size-9 items-center justify-center rounded-[8px] border bg-background text-(--thread-accent-primary)"
        >
          <span className="font-mono text-sm font-semibold">C</span>
        </Link>

        <nav className="flex flex-1 flex-col items-center gap-1 pt-2">
          {NAV.map((item) => (
            <RailLink key={item.href} item={item} active={item.match(pathname)} />
          ))}
        </nav>

        <div className="flex flex-col items-center gap-1">
          <ThemeToggle />
          <UserButton />
        </div>
      </aside>

      {/* Menu mobile */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
          className="fixed left-3 top-3 z-50 flex size-9 items-center justify-center rounded-[8px] border bg-background text-muted-foreground shadow-sm"
        >
          {mobileOpen ? (
            <XIcon className="size-4" />
          ) : (
            <MenuIcon className="size-4" />
          )}
        </button>

        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40"
              onClick={() => setMobileOpen(false)}
            />
            <div className="fixed left-3 top-14 z-50 flex w-48 flex-col gap-1 rounded-[10px] border bg-popover p-2 shadow-lg">
              {NAV.map((item) => {
                const active = item.match(pathname);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2.5 rounded-[6px] px-3 py-2.5 text-sm",
                      active
                        ? "bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
              <div className="my-1 h-px bg-border" />
              <div className="flex items-center justify-between px-1">
                <ThemeToggle withLabel />
                <UserButton withLabel />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Onboarding de primeiro uso (auto-contido; só dispara uma vez) */}
      <OnboardingDialog />
    </>
  );
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={item.href}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex size-9 items-center justify-center rounded-[8px] transition-colors",
              active
                ? "bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" />
          </Link>
        }
      />
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Flag de montagem para evitar mismatch de hydration do tema (padrão canônico
  // do next-themes) — o set só pode acontecer client-side, no effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";
  const toggle = () => setTheme(isDark ? "light" : "dark");

  // Evita mismatch de hydration: antes de montar, o server não conhece o tema
  // resolvido — ícone E aria-label precisam do mesmo placeholder neutro, senão
  // o aria-label diverge no hydrate (isDark é indefinido no SSR).
  const Icon = !mounted ? SunIcon : isDark ? SunIcon : MoonIcon;
  const label = !mounted ? "Alternar tema" : isDark ? "Tema claro" : "Tema escuro";

  if (withLabel) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        className="flex size-9 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Icon className="size-[18px]" />
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            className="flex size-9 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon className="size-[18px]" />
          </button>
        }
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function UserButton({ withLabel = false }: { withLabel?: boolean }) {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <span className="flex size-9 items-center justify-center text-muted-foreground">
        <span className="size-4 animate-pulse rounded-full bg-muted" />
      </span>
    );
  }

  if (!session?.user) {
    const onLogin = () =>
      signIn.social({
        provider: "google",
        callbackURL:
          typeof window !== "undefined" ? window.location.pathname : "/",
      });
    return (
      <button
        type="button"
        onClick={onLogin}
        aria-label="Entrar"
        className="flex size-9 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <LogInIcon className="size-[18px]" />
      </button>
    );
  }

  const initial = (session.user.name ?? session.user.email ?? "?")
    .charAt(0)
    .toUpperCase();

  const button = (
    <button
      type="button"
      onClick={() => signOut()}
      aria-label="Sair"
      title={session.user.email ?? "Sair"}
      className="group relative flex size-9 items-center justify-center rounded-full"
    >
      <span className="flex size-7 items-center justify-center rounded-full border bg-background font-mono text-xs text-foreground group-hover:opacity-0">
        {initial}
      </span>
      <LogOutIcon className="absolute size-[18px] text-muted-foreground opacity-0 group-hover:opacity-100" />
    </button>
  );

  if (withLabel) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">
        {session.user.email ?? "Sair"} · sair
      </TooltipContent>
    </Tooltip>
  );
}
