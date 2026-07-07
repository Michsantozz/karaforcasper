"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  UsersIcon,
  BellIcon,
  WalletIcon,
  Link2Icon,
  InboxIcon,
  ExternalLinkIcon,
  Trash2Icon,
  LoaderIcon,
  PlusIcon,
  LogOutIcon,
  CopyIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import { useCasperWallet } from "@/features/wallet/model/useCasperWallet";
import { signMessageWithWallet } from "@/features/wallet/model/provider";
import { useSession, signIn, signOut } from "@/features/auth/model/auth-client";
import {
  useMyRequests,
  usePendingRequests,
  useNotifications,
  useLinkedWallets,
  useMarkNotificationRead,
  invalidateSignatureFlow,
  qk,
} from "@/features/multisig/model/queries";
import { cn } from "@/shared/lib/utils";
import { AppShell } from "@/features/auth/ui/AppShell";

// Erros do POST /api/user-wallets → mensagem amigável.
const LINK_ERROR_MSG: Record<string, string> = {
  invalid_public_key: "Chave pública inválida.",
  invalid_nonce: "Nonce inválido — tente de novo.",
  nonce_already_used: "Nonce já usado — tente de novo.",
  nonce_expired: "Nonce expirou — tente de novo.",
  proof_failed: "Prova de posse falhou: a assinatura não bate com a carteira.",
};

function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

/**
 * Dashboard /multisig (auth): solicitações criadas + "aguardando minha
 * assinatura" (match por carteira vinculada) + sininho de notificações +
 * vincular carteira.
 */
function MultisigDashboard() {
  const { data: session, isPending } = useSession();
  const wallet = useCasperWallet();

  const client = useQueryClient();
  const [tab, setTab] = useState<"mine" | "pending">("mine");
  const [mineFilter, setMineFilter] = useState<"active" | "all">("active");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  // Todas as listas viram queries. O polling de 8s (refetchInterval) é herdado
  // via qk.mine/pending/... — aqui só ligamos o intervalo no dashboard todo.
  // enabled só com sessão. As 4 queries compartilham o QueryClient, então dedup
  // e cache são automáticos; invalidar qualquer uma revalida em todo lugar.
  const enabled = Boolean(session?.user);
  const mineQ = useMyRequests(mineFilter, enabled);
  const pendingQ = usePendingRequests(enabled);
  const notifsQ = useNotifications(enabled);
  const walletsQ = useLinkedWallets(enabled);

  const mine = mineQ.data ?? [];
  const pending = pendingQ.data ?? [];
  const notifs = notifsQ.data ?? [];
  const wallets = walletsQ.data ?? [];
  // Qualquer query em erro → banner "falha ao carregar" (antes: flag manual).
  const fetchError =
    mineQ.isError || pendingQ.isError || notifsQ.isError || walletsQ.isError;

  const markReadMut = useMarkNotificationRead();

  // Polling do dashboard: signatários remotos podem assinar a qualquer momento.
  // Refetch das 4 listas a cada 8s enquanto logado.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      void client.invalidateQueries({ queryKey: qk.signatureRequests });
      void client.invalidateQueries({ queryKey: qk.notifications });
      void client.invalidateQueries({ queryKey: qk.userWallets });
    }, 8000);
    return () => clearInterval(t);
  }, [enabled, client]);

  // Restaura o último link criado se o usuário recarregou antes de compartilhá-lo.
  useEffect(() => {
    const saved = sessionStorage.getItem("multisig:lastCreatedLink");
    // sessionStorage é client-only; restaurar é I/O de montagem.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setCreatedLink(saved);
  }, []);

  // Vincular carteira COM PROVA DE POSSE (SIWE-style):
  //  1. pede um nonce ao backend;
  //  2. a carteira assina o nonce (signMessage, popup);
  //  3. POSTa pubkey + nonce + assinatura — o backend verifica antes de gravar.
  const linkActiveWallet = useCallback(async () => {
    setLinkMsg(null);
    let key = wallet.activeKey;
    if (!key) key = await wallet.connect();
    if (!key) {
      setLinkMsg("Conecte a carteira primeiro.");
      return;
    }
    setBusy(true);
    try {
      // 1. nonce
      const nonceRes = await fetch("/api/user-wallets/nonce", {
        method: "POST",
      });
      if (!nonceRes.ok) {
        setLinkMsg("Falha ao obter nonce.");
        return;
      }
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      // 2. assina o nonce (a extensão prefixa "Casper Message:\n")
      const out = await signMessageWithWallet(nonce, key);
      if (!out.signed || !out.signatureHex) {
        setLinkMsg(out.error ?? "Assinatura cancelada.");
        return;
      }

      // 3. vincula com a prova
      const res = await fetch("/api/user-wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKeyHex: key,
          nonce,
          signatureHex: out.signatureHex,
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setLinkMsg(
          LINK_ERROR_MSG[err.error ?? ""] ??
            `Falha ao vincular: ${err.error ?? res.status}`,
        );
        return;
      }
      setLinkMsg("Carteira vinculada ✓");
      invalidateSignatureFlow(client);
    } catch (e) {
      setLinkMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wallet, client]);

  const unlink = useCallback(
    async (publicKeyHex: string) => {
      setBusy(true);
      try {
        await fetch("/api/user-wallets", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicKeyHex }),
        });
        invalidateSignatureFlow(client);
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  // Marcar notificação como lida via mutation (invalida só as notificações).
  const markRead = useCallback(
    (notifId: string) => void markReadMut.mutate(notifId),
    [markReadMut],
  );

  const createRequest = useCallback(
    async (form: {
      transactionJson: string;
      requiredSigners: { publicKeyHex: string; label?: string }[];
      threshold: number;
      description?: string;
    }) => {
      setBusy(true);
      setCreatedLink(null);
      try {
        const res = await fetch("/api/signature-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "payment", ...form }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          const map: Record<string, string> = {
            transfer_below_minimum:
              "Valor abaixo do mínimo da rede (2.5 CSPR).",
            invalid_transaction_json: "Transação inválida.",
            transaction_too_large: "Transação grande demais.",
          };
          setLinkMsg(map[err.error ?? ""] ?? `Falha ao criar: ${err.error ?? res.status}`);
          return;
        }
        const data = (await res.json()) as { link: string };
        const fullLink = `${window.location.origin}${data.link}`;
        setCreatedLink(fullLink);
        // Persiste na sessão para o link não sumir se o usuário recarregar antes
        // de compartilhá-lo. Some ao fechar a aba.
        sessionStorage.setItem("multisig:lastCreatedLink", fullLink);
        setShowCreate(false);
        invalidateSignatureFlow(client);
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const cancelRequest = useCallback(
    async (requestId: string) => {
      setBusy(true);
      try {
        await fetch(`/api/signature-requests/${requestId}/cancel`, {
          method: "POST",
        });
        invalidateSignatureFlow(client);
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const unread = notifs.filter((n) => !n.readAt).length;

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="flex items-center gap-2 font-mono text-muted-foreground text-sm">
          <LoaderIcon className="size-4 animate-spin" />
          carregando…
        </div>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center gap-5 px-4 py-10">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-10 items-center justify-center rounded-[8px] border bg-background">
            <UsersIcon className="size-5 text-(--thread-accent-primary)" />
          </span>
          <h1 className="font-semibold text-lg tracking-tight">
            Multisig — coleta de assinaturas
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Entre para criar solicitações de pagamento, vincular sua carteira e
            acompanhar o que aguarda sua assinatura.
          </p>
        </div>
        <Button
          onClick={() =>
            signIn.social({ provider: "google", callbackURL: "/multisig" })
          }
        >
          Entrar com Google
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-16 md:pt-10">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-[5px] border bg-background">
            <UsersIcon className="size-4 text-(--thread-accent-primary)" />
          </span>
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">
              Assinaturas
            </h1>
            <p className="font-mono text-[11px] text-muted-foreground">
              {session.user.email}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="#notificacoes"
            aria-label={
              unread > 0
                ? `${unread} notificações não lidas — ir para notificações`
                : "Ir para notificações"
            }
            className="relative flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <BellIcon className="size-4" />
            {unread > 0 && (
              <span className="absolute -top-1 -right-2 flex size-4 items-center justify-center rounded-full bg-(--thread-accent-secondary) text-[9px] text-white">
                {unread}
              </span>
            )}
          </a>
          <button
            type="button"
            onClick={() => signOut()}
            className="text-muted-foreground hover:text-foreground"
            aria-label="sair"
          >
            <LogOutIcon className="size-4" />
          </button>
        </div>
      </header>

      {fetchError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[6px] border border-(--thread-accent-secondary)/40 bg-(--thread-accent-secondary)/10 px-3 py-2 font-mono text-[11px] text-(--thread-accent-secondary)">
          <span>Falha ao carregar dados. Verifique sua conexão.</span>
          <button
            type="button"
            onClick={() => invalidateSignatureFlow(client)}
            className="shrink-0 underline hover:no-underline"
          >
            tentar de novo
          </button>
        </div>
      )}

      {/* Criar solicitação */}
      <div className="mb-4 flex items-center justify-between">
        <Button
          variant="default"
          size="sm"
          className="rounded-[5px] font-mono text-xs"
          onClick={() => setShowCreate((v) => !v)}
        >
          <PlusIcon className="size-3.5" />
          nova solicitação
        </Button>
      </div>

      {createdLink && (
        <div className="mb-4 flex items-center gap-2 rounded-[5px] border border-(--thread-accent-primary) bg-background px-3 py-2">
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            link
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {createdLink}
          </span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(createdLink)}
            className="text-muted-foreground hover:text-(--thread-accent-primary)"
            aria-label="copiar"
          >
            <CopyIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setCreatedLink(null);
              sessionStorage.removeItem("multisig:lastCreatedLink");
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="dispensar"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      {showCreate && (
        <CreateRequestForm
          busy={busy}
          onSubmit={createRequest}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* Carteiras vinculadas */}
      <div className="mb-4 rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
            <WalletIcon className="size-3.5" />
            carteiras vinculadas
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-[5px] font-mono text-[11px]"
            onClick={linkActiveWallet}
            disabled={busy || !wallet.installed}
          >
            <Link2Icon className="size-3" />
            vincular ativa
          </Button>
        </div>
        {linkMsg && (
          <div
            aria-live="polite"
            className={cn(
              "px-2 pb-1 font-mono text-[11px]",
              linkMsg.includes("✓")
                ? "text-(--thread-accent-primary)"
                : "text-(--thread-accent-secondary)",
            )}
          >
            {linkMsg}
          </div>
        )}
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-3">
          {wallets.length === 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              nenhuma carteira vinculada
            </span>
          ) : (
            wallets.map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px]">
                  {w.label ? `${w.label} · ` : ""}
                  {short(w.publicKeyHex)}
                </span>
                <button
                  type="button"
                  onClick={() => unlink(w.publicKeyHex)}
                  disabled={busy}
                  className="text-muted-foreground hover:text-(--thread-accent-secondary)"
                  aria-label="desvincular"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="solicitações" className="mb-3 flex gap-2">
        <TabButton
          id="tab-mine"
          active={tab === "mine"}
          onClick={() => setTab("mine")}
        >
          minhas ({mine.length})
        </TabButton>
        <TabButton
          id="tab-pending"
          active={tab === "pending"}
          onClick={() => setTab("pending")}
        >
          aguardando minha assinatura ({pending.length})
        </TabButton>
      </div>

      {tab === "mine" ? (
        <div role="tabpanel" aria-labelledby="tab-mine">
          <div className="mb-2 flex items-center gap-1.5">
            {(["active", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setMineFilter(f)}
                aria-pressed={mineFilter === f}
                className={cn(
                  "rounded-[4px] px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
                  mineFilter === f
                    ? "bg-(--thread-accent-primary)/10 text-(--thread-accent-primary)"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f === "active" ? "ativas" : "histórico"}
              </button>
            ))}
          </div>
          <RequestList
            empty="você não criou solicitações."
            items={mine.map((r) => ({
              id: r.id,
              title: r.description ?? `${r.kind} · ${r.id}`,
              meta: `${r.status} · ${r.threshold} assinaturas`,
              href: `/multisig/${r.id}`,
              hash: r.transactionHash,
              onCancel:
                r.status === "pending" || r.status === "ready"
                  ? () => cancelRequest(r.id)
                  : undefined,
            }))}
          />
        </div>
      ) : (
        <div role="tabpanel" aria-labelledby="tab-pending">
          <RequestList
            empty="nada aguardando sua assinatura."
            items={pending.map((p) => ({
              id: p.id,
              title: p.description ?? `${p.kind} · ${p.id}`,
              meta: `${p.signedCount}/${p.threshold} signed · ${p.status}`,
              href: p.link,
              hash: null,
            }))}
          />
        </div>
      )}

      {/* Notificações */}
      <div
        id="notificacoes"
        className="mt-6 scroll-mt-4 rounded-[8px] bg-(--thread-frame-outer) p-1"
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-muted-foreground text-xs">
          <InboxIcon className="size-3.5" />
          notificações
        </div>
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-3">
          {notifs.length === 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              sem notificações
            </span>
          ) : (
            notifs.map((n) => (
              <button
                type="button"
                key={n.id}
                onClick={() => !n.readAt && markRead(n.id)}
                className={cn(
                  "flex items-start gap-2 rounded-[4px] px-2 py-1.5 text-left",
                  n.readAt
                    ? "text-muted-foreground"
                    : "bg-(--thread-accent-primary-soft,transparent) text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    n.readAt ? "bg-muted-foreground" : "bg-(--thread-accent-primary)",
                  )}
                />
                <span className="font-mono text-[11px]">{n.message}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

function TabButton({
  id,
  active,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-[5px] border px-3 py-1.5 font-mono text-[11px]",
        active
          ? "border-(--thread-accent-primary) text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RequestList({
  items,
  empty,
}: {
  items: {
    id: string;
    title: string;
    meta: string;
    href: string;
    hash: string | null;
    onCancel?: () => void;
  }[];
  empty: string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-[5px] border bg-background p-4 font-mono text-[11px] text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => (
        <div
          key={it.id}
          className="flex items-center justify-between gap-3 rounded-[5px] border bg-background p-3 hover:border-(--thread-accent-primary)"
        >
          <a href={it.href} className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-sm">{it.title}</p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {it.meta}
            </p>
          </a>
          <div className="flex shrink-0 items-center gap-2">
            {it.onCancel && (
              <button
                type="button"
                onClick={it.onCancel}
                className="text-muted-foreground hover:text-(--thread-accent-secondary)"
                aria-label="cancelar solicitação"
                title="cancelar"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            )}
            <a href={it.href} aria-label="abrir">
              <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Form de criação de solicitação. Monta a tx base (transfer nativo multisig) no
 * client via casper-js-sdk e POSTa transactionJson + signatários ao backend. Usa
 * `.build()` (Transaction 2.0) — mesmo formato do fluxo de user-transfer que já
 * funciona com a Casper Wallet.
 */
function CreateRequestForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (form: {
    transactionJson: string;
    requiredSigners: { publicKeyHex: string; label?: string }[];
    threshold: number;
    description?: string;
  }) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [signersRaw, setSignersRaw] = useState("");
  const [threshold, setThreshold] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const submit = useCallback(async () => {
    setError(null);
    setBuilding(true);
    try {
      const amountCspr = Number(amount);
      if (!from || !to || !amountCspr) {
        setError("Preencha pagadora, destino e valor.");
        return;
      }
      // A rede recusa transfer nativo abaixo de 2.5 CSPR.
      if (amountCspr < 2.5) {
        setError("Valor mínimo de transferência na rede é 2.5 CSPR.");
        return;
      }
      // Signatários extras (além da pagadora), um por linha: "pubkey" ou "pubkey,label".
      const extra = signersRaw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [pk, label] = l.split(",").map((s) => s.trim());
          return { publicKeyHex: pk, label: label || undefined };
        });

      const { NativeTransferBuilder, PublicKey, CasperNetworkName } =
        await import("casper-js-sdk");
      const tx = new NativeTransferBuilder()
        .from(PublicKey.fromHex(from))
        .target(PublicKey.fromHex(to))
        .amount(
          BigInt(Math.round(amountCspr * 1_000_000_000)).toString(),
        )
        .id(Date.now() % 1_000_000)
        .chainName(CasperNetworkName.Testnet)
        .payment(100_000_000)
        .build();

      // Pagadora é sempre signatária exigida.
      const requiredSigners = [
        { publicKeyHex: from, label: "pagadora" },
        ...extra,
      ];
      const th = Number(threshold) || requiredSigners.length;

      onSubmit({
        transactionJson: JSON.stringify(tx.toJSON()),
        requiredSigners,
        threshold: th,
        description: description || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }, [from, to, amount, signersRaw, threshold, description, onSubmit]);

  return (
    <div className="mb-4 rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="px-2 py-1.5 font-mono text-muted-foreground text-xs">
        nova solicitação de pagamento
      </div>
      <div className="flex flex-col gap-2 rounded-[5px] border bg-background p-3">
        <Field label="carteira pagadora (from)" value={from} onChange={setFrom} />
        <Field label="destino (to)" value={to} onChange={setTo} />
        <Field
          label="valor (CSPR)"
          value={amount}
          onChange={setAmount}
          placeholder="1.5"
        />
        <Field
          label="quórum (threshold, opcional)"
          value={threshold}
          onChange={setThreshold}
          placeholder="padrão: todos"
        />
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            outros signatários (1 por linha: pubkey ou pubkey,label)
          </span>
          <textarea
            value={signersRaw}
            onChange={(e) => setSignersRaw(e.target.value)}
            rows={3}
            className="rounded-[4px] border bg-background px-2 py-1 font-mono text-[11px]"
          />
        </label>
        <Field
          label="descrição (opcional)"
          value={description}
          onChange={setDescription}
        />
        {error && (
          <span className="font-mono text-[11px] text-(--thread-accent-secondary)">
            {error}
          </span>
        )}
        <div className="mt-1 flex gap-2">
          <Button
            size="sm"
            className="rounded-[5px] font-mono text-xs"
            onClick={submit}
            disabled={busy || building}
          >
            {building ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            criar + gerar link
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-[5px] font-mono text-xs"
            onClick={onCancel}
            disabled={building}
          >
            cancelar
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-[4px] border bg-background px-2 py-1 font-mono text-[11px]"
      />
    </label>
  );
}

// Wrapper com o shell de navegação global (rail + theme + onboarding). O
// dashboard em si permanece como MultisigDashboard; aqui só envolvemos com o
// AppShell e abrimos espaço para o rail (md:pl-14).
export default function MultisigPage() {
  return (
    <div className="md:pl-14">
      <AppShell />
      <MultisigDashboard />
    </div>
  );
}
