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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog";
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

// Errors from POST /api/user-wallets → friendly message.
const LINK_ERROR_MSG: Record<string, string> = {
  invalid_public_key: "Invalid public key.",
  invalid_nonce: "Invalid nonce — try again.",
  nonce_already_used: "Nonce already used — try again.",
  nonce_expired: "Nonce expired — try again.",
  proof_failed: "Proof of possession failed: the signature doesn't match the wallet.",
};

function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

/**
 * Destructive icon button with confirmation. Matches the dashboard's
 * unlink/cancel to the pattern used on detail pages (broadcast/cancel already
 * use AlertDialog); previously it was a single click with no undo.
 */
function ConfirmIconButton({
  icon: Icon,
  title,
  description,
  confirmLabel,
  ariaLabel,
  disabled,
  onConfirm,
}: {
  icon: typeof Trash2Icon;
  title: string;
  description: string;
  confirmLabel: string;
  ariaLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="text-muted-foreground hover:text-(--thread-accent-secondary) disabled:opacity-50"
            aria-label={ariaLabel}
            title={ariaLabel}
          />
        }
      >
        <Icon className="size-3.5" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            render={
              <Button
                variant="outline"
                size="sm"
                className="rounded-[5px] font-mono text-xs"
              />
            }
          >
            back
          </AlertDialogCancel>
          <AlertDialogAction
            render={
              <Button
                variant="default"
                size="sm"
                className="rounded-[5px] font-mono text-xs"
              />
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Dashboard /multisig (auth): requests created + "awaiting my signature"
 * (matched by linked wallet) + notifications bell + link wallet.
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

  // All lists become queries. The 8s polling (refetchInterval) is inherited
  // via qk.mine/pending/... — here we just enable the interval for the whole
  // dashboard. enabled only with a session. The 4 queries share the
  // QueryClient, so dedup and caching are automatic; invalidating any one
  // revalidates everywhere.
  const enabled = Boolean(session?.user);
  const mineQ = useMyRequests(mineFilter, enabled);
  const pendingQ = usePendingRequests(enabled);
  const notifsQ = useNotifications(enabled);
  const walletsQ = useLinkedWallets(enabled);

  const mine = mineQ.data ?? [];
  const pending = pendingQ.data ?? [];
  const notifs = notifsQ.data ?? [];
  const wallets = walletsQ.data ?? [];
  // Any query in error → "failed to load" banner (previously: manual flag).
  const fetchError =
    mineQ.isError || pendingQ.isError || notifsQ.isError || walletsQ.isError;

  const markReadMut = useMarkNotificationRead();

  // Dashboard polling: remote signers can sign at any moment.
  // Refetch the 4 lists every 8s while logged in.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      void client.invalidateQueries({ queryKey: qk.signatureRequests });
      void client.invalidateQueries({ queryKey: qk.notifications });
      void client.invalidateQueries({ queryKey: qk.userWallets });
    }, 8000);
    return () => clearInterval(t);
  }, [enabled, client]);

  // Restores the last created link if the user reloaded before sharing it.
  useEffect(() => {
    const saved = sessionStorage.getItem("multisig:lastCreatedLink");
    // sessionStorage is client-only; restoring it is mount-time I/O.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setCreatedLink(saved);
  }, []);

  // Link wallet WITH PROOF OF POSSESSION (SIWE-style):
  //  1. requests a nonce from the backend;
  //  2. the wallet signs the nonce (signMessage, popup);
  //  3. POSTs pubkey + nonce + signature — the backend verifies before saving.
  const linkActiveWallet = useCallback(async () => {
    setLinkMsg(null);
    let key = wallet.activeKey;
    if (!key) key = await wallet.connect();
    if (!key) {
      setLinkMsg("Connect the wallet first.");
      return;
    }
    setBusy(true);
    try {
      // 1. nonce
      const nonceRes = await fetch("/api/user-wallets/nonce", {
        method: "POST",
      });
      if (!nonceRes.ok) {
        setLinkMsg("Failed to get nonce.");
        return;
      }
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      // 2. signs the nonce (the extension prefixes "Casper Message:\n")
      const out = await signMessageWithWallet(nonce, key);
      if (!out.signed || !out.signatureHex) {
        setLinkMsg(out.error ?? "Signature cancelled.");
        return;
      }

      // 3. links with the proof
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
            `Failed to link: ${err.error ?? res.status}`,
        );
        return;
      }
      setLinkMsg("Wallet linked ✓");
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

  // Mark a notification as read via mutation (invalidates only notifications).
  const markRead = useCallback(
    (notifId: string) => void markReadMut.mutate(notifId),
    [markReadMut],
  );

  const createRequest = useCallback(
    async (form: {
      transactionJson: string;
      requiredSigners: { publicKeyHex: string; label?: string; email?: string }[];
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
              "Amount below the network minimum (2.5 CSPR).",
            invalid_transaction_json: "Invalid transaction.",
            transaction_too_large: "Transaction too large.",
          };
          setLinkMsg(map[err.error ?? ""] ?? `Failed to create: ${err.error ?? res.status}`);
          return;
        }
        const data = (await res.json()) as { link: string };
        const fullLink = `${window.location.origin}${data.link}`;
        setCreatedLink(fullLink);
        // Persists in the session so the link doesn't disappear if the user
        // reloads before sharing it. Cleared when the tab closes.
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
          loading…
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
            Multisig — signature collection
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Log in to create payment requests, link your wallet, and track
            what&apos;s awaiting your signature.
          </p>
        </div>
        <Button
          onClick={() =>
            signIn.social({ provider: "google", callbackURL: "/multisig" })
          }
        >
          Sign in with Google
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
              Signatures
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
                ? `${unread} unread notifications — go to notifications`
                : "Go to notifications"
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
            aria-label="sign out"
          >
            <LogOutIcon className="size-4" />
          </button>
        </div>
      </header>

      {fetchError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[6px] border border-(--thread-accent-secondary)/40 bg-(--thread-accent-secondary)/10 px-3 py-2 font-mono text-[11px] text-(--thread-accent-secondary)">
          <span>Failed to load data. Check your connection.</span>
          <button
            type="button"
            onClick={() => invalidateSignatureFlow(client)}
            className="shrink-0 underline hover:no-underline"
          >
            try again
          </button>
        </div>
      )}

      {/* Create request */}
      <div className="mb-4 flex items-center justify-between">
        <Button
          variant="default"
          size="sm"
          className="rounded-[5px] font-mono text-xs"
          onClick={() => setShowCreate((v) => !v)}
        >
          <PlusIcon className="size-3.5" />
          new request
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
            aria-label="copy"
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
            aria-label="dismiss"
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

      {/* Linked wallets */}
      <div className="mb-4 rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
            <WalletIcon className="size-3.5" />
            linked wallets
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-[5px] font-mono text-[11px]"
            onClick={linkActiveWallet}
            disabled={busy || !wallet.installed}
          >
            <Link2Icon className="size-3" />
            link active
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
              no linked wallets
            </span>
          ) : (
            wallets.map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px]">
                  {w.label ? `${w.label} · ` : ""}
                  {short(w.publicKeyHex)}
                </span>
                <ConfirmIconButton
                  icon={Trash2Icon}
                  ariaLabel="unlink"
                  title="Unlink wallet?"
                  description={`The wallet ${short(
                    w.publicKeyHex,
                  )} will stop appearing under "awaiting my signature". You can re-link it later by signing the proof of possession again.`}
                  confirmLabel="unlink"
                  disabled={busy}
                  onConfirm={() => unlink(w.publicKeyHex)}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="requests" className="mb-3 flex gap-2">
        <TabButton
          id="tab-mine"
          active={tab === "mine"}
          onClick={() => setTab("mine")}
        >
          mine ({mine.length})
        </TabButton>
        <TabButton
          id="tab-pending"
          active={tab === "pending"}
          onClick={() => setTab("pending")}
        >
          awaiting my signature ({pending.length})
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
                {f === "active" ? "active" : "history"}
              </button>
            ))}
          </div>
          <RequestList
            empty="you haven't created any requests."
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
            empty="nothing awaiting your signature."
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

      {/* Notifications */}
      <div
        id="notificacoes"
        className="mt-6 scroll-mt-4 rounded-[8px] bg-(--thread-frame-outer) p-1"
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-muted-foreground text-xs">
          <InboxIcon className="size-3.5" />
          notifications
        </div>
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-3">
          {notifs.length === 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              no notifications
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
              <ConfirmIconButton
                icon={Trash2Icon}
                ariaLabel="cancel request"
                title="Cancel request?"
                description="Invalidates the signature link. Signatures already collected are discarded. This cannot be undone."
                confirmLabel="confirm cancellation"
                onConfirm={it.onCancel}
              />
            )}
            <a href={it.href} aria-label="open">
              <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Request creation form. Builds the base tx (native multisig transfer) on
 * the client via casper-js-sdk and POSTs transactionJson + signers to the
 * backend. Uses `.build()` (Transaction 2.0) — the same format as the
 * user-transfer flow that already works with the Casper Wallet.
 */
function CreateRequestForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (form: {
    transactionJson: string;
    requiredSigners: { publicKeyHex: string; label?: string; email?: string }[];
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
        setError("Fill in payer, target, and amount.");
        return;
      }
      // The network rejects a native transfer below 2.5 CSPR.
      if (amountCspr < 2.5) {
        setError("The minimum transfer amount on the network is 2.5 CSPR.");
        return;
      }
      // Extra signers (besides the payer), one per line:
      // "pubkey" | "pubkey,label" | "pubkey,label,email". The email is
      // optional and is used to invite a signer WITHOUT a linked account —
      // the backend sends the /sign link directly to them. Anyone who
      // already has a linked wallet is matched automatically and doesn't
      // need the email here.
      const extra = signersRaw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [pk, label, email] = l.split(",").map((s) => s.trim());
          return {
            publicKeyHex: pk,
            label: label || undefined,
            email: email || undefined,
          };
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

      // The payer is always a required signer.
      const requiredSigners = [
        { publicKeyHex: from, label: "payer" },
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
        new payment request
      </div>
      <div className="flex flex-col gap-2 rounded-[5px] border bg-background p-3">
        <Field label="payer wallet (from)" value={from} onChange={setFrom} />
        <Field label="target (to)" value={to} onChange={setTo} />
        <Field
          label="amount (CSPR)"
          value={amount}
          onChange={setAmount}
          placeholder="1.5"
        />
        <Field
          label="quorum (threshold, optional)"
          value={threshold}
          onChange={setThreshold}
          placeholder="default: all"
        />
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            other signers (1 per line: pubkey | pubkey,label | pubkey,label,email)
          </span>
          <textarea
            value={signersRaw}
            onChange={(e) => setSignersRaw(e.target.value)}
            rows={3}
            className="rounded-[4px] border bg-background px-2 py-1 font-mono text-[11px]"
          />
        </label>
        <Field
          label="description (optional)"
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
            create + generate link
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-[5px] font-mono text-xs"
            onClick={onCancel}
            disabled={building}
          >
            cancel
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

// Wrapper with the global navigation shell (rail + theme + onboarding). The
// dashboard itself remains MultisigDashboard; here we just wrap it with
// AppShell and make room for the rail (md:pl-14).
export default function MultisigPage() {
  return (
    <div className="md:pl-14">
      <AppShell />
      <MultisigDashboard />
    </div>
  );
}
