"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  MessageSquareIcon,
  VideoIcon,
  UsersIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import { useSession } from "@/features/auth/model/auth-client";

const STORAGE_KEY = "casper:onboarded:v1";

type Feature = {
  icon: LucideIcon;
  title: string;
  desc: string;
  href: string;
  cta: string;
};

const FEATURES: Feature[] = [
  {
    icon: MessageSquareIcon,
    title: "Converse com o agente",
    desc: "Peça saldo, faça transferências e analise trades on-chain na Casper — tudo pela conversa.",
    href: "/",
    cta: "Abrir chat",
  },
  {
    icon: VideoIcon,
    title: "Agente de reuniões",
    desc: "Envie bots a reuniões, grave, transcreva e conecte sua agenda para agendar por evento.",
    href: "/meetings",
    cta: "Ir para reuniões",
  },
  {
    icon: UsersIcon,
    title: "Multisig & assinaturas",
    desc: "Crie solicitações de assinatura distribuída, acompanhe o quórum e faça broadcast.",
    href: "/multisig",
    cta: "Abrir multisig",
  },
];

/**
 * Experiência de primeiro uso. Antes o login levava direto ao chat seco, sem
 * contexto do que o produto faz. Mostra uma vez (flag em localStorage) um
 * resumo das três áreas com atalhos. Auto-contido: só dispara para sessão ativa
 * e some após visto ou dispensado.
 */
export function OnboardingDialog() {
  const { data: session, isPending } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isPending || !session?.user) return;
    try {
      // localStorage só existe client-side; abrir depende dele, logo é no effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true);
    } catch {
      /* localStorage indisponível — não bloqueia */
    }
  }, [isPending, session?.user]);

  const dismiss = (next: boolean) => {
    if (!next) {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={dismiss}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <span className="mb-1 flex size-10 items-center justify-center rounded-[10px] border bg-background text-(--thread-accent-primary)">
            <SparklesIcon className="size-5" />
          </span>
          <DialogTitle>Bem-vindo ao Casper Agent</DialogTitle>
          <DialogDescription>
            Um agente autônomo na Casper Network. Veja o que dá para fazer:
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3 py-2">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <li
                key={f.href}
                className="flex items-start gap-3 rounded-[8px] border bg-background p-3"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)">
                  <Icon className="size-4" />
                </span>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{f.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.desc}
                  </span>
                </div>
                <DialogClose
                  render={
                    <Link
                      href={f.href}
                      className="shrink-0 self-center font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
                    >
                      {f.cta} →
                    </Link>
                  }
                />
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button onClick={() => dismiss(false)}>Começar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
