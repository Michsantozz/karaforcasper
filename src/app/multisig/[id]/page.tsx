"use client";

import { use, useState } from "react";
import Link from "next/link";
import {
  UsersIcon,
  ArrowLeftIcon,
  CopyIcon,
  CoinsIcon,
  TargetIcon,
  SendIcon,
  Trash2Icon,
  LoaderIcon,
  CircleAlertIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
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
import { useSession } from "@/features/auth/model/auth-client";
import {
  useRequestDetail,
  useBroadcastRequest,
  useCancelRequest,
} from "@/features/multisig/model/queries";
import { cn } from "@/shared/lib/utils";

function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function norm(hex: string) {
  return hex.trim().toLowerCase();
}

/**
 * CREATOR's view of a request (/multisig/:id) — management, distinct from
 * the public signature page (/sign/:id). Shows the real amount/target,
 * per-signer progress, shareable link, cancel (while pending|ready), and
 * broadcast (once quorum is reached). Login-gated; polls to track progress.
 */
export default function CreatorRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: session, isPending } = useSession();

  const [msg, setMsg] = useState<string | null>(null);
  const [broadcastUrl, setBroadcastUrl] = useState<string | null>(null);

  // Detail + terminal-aware polling come from the shared hook. `enabled`
  // only fires with a session. `detail` is undefined while loading.
  // isLoading = first fetch in progress (isPending && isFetching). With the
  // query disabled (no session) it's false, so the login branch below is
  // reachable instead of getting stuck on the spinner.
  const { data: detail, isLoading: loading } = useRequestDetail(
    id,
    Boolean(session?.user),
  );

  const cancelMut = useCancelRequest(id);
  const broadcastMut = useBroadcastRequest(id);
  const busy = cancelMut.isPending || broadcastMut.isPending;

  const shareLink =
    typeof window !== "undefined" ? `${window.location.origin}/sign/${id}` : "";

  const onCancel = async () => {
    setMsg(null);
    const { ok, status, data } = await cancelMut.mutateAsync();
    const err = data as { error?: string };
    if (!ok) {
      setMsg(
        err.error === "forbidden"
          ? "Only the creator can cancel."
          : `Failed to cancel: ${err.error ?? status}`,
      );
      return;
    }
    setMsg("Request cancelled.");
  };

  const onBroadcast = async () => {
    setMsg(null);
    const { ok, status, data } = await broadcastMut.mutateAsync();
    const d = data as { error?: string; explorerUrl?: string };
    if (!ok) {
      const map: Record<string, string> = {
        forbidden: "Only the creator can submit.",
        request_not_ready: "Quorum not yet reached.",
        unauthenticated: "Log in to submit.",
      };
      setMsg(map[d.error ?? ""] ?? `Broadcast failed: ${d.error ?? status}`);
      return;
    }
    setBroadcastUrl(d.explorerUrl ?? null);
    setMsg("Transaction submitted ✓");
  };

  if (isPending || loading) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <div className="flex items-center gap-2 font-mono text-muted-foreground text-sm">
          <LoaderIcon className="size-4 animate-spin" />
          loading request…
        </div>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <p className="text-sm text-muted-foreground">
          Log in on the <Link href="/multisig" className="underline">dashboard</Link> to manage your requests.
        </p>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <div className="flex items-center gap-2 rounded-[5px] border border-(--thread-accent-secondary) bg-(--thread-accent-secondary-soft) px-3 py-2">
          <CircleAlertIcon className="size-4 text-(--thread-accent-secondary)" />
          <span className="text-(--thread-accent-secondary) text-sm">
            Request not found or expired.
          </span>
        </div>
      </main>
    );
  }

  const terminal = ["broadcast", "confirmed", "cancelled", "expired"].includes(
    detail.status,
  );
  const cancellable = detail.status === "pending" || detail.status === "ready";

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <Link
        href="/multisig"
        className="mb-4 inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        back to dashboard
      </Link>

      <header className="mb-6 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-[5px] border bg-background">
          <UsersIcon className="size-4 text-(--thread-accent-primary)" />
        </span>
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Manage request
          </h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            {detail.kind} · {detail.chainName} · {detail.status}
          </p>
        </div>
      </header>

      {/* Shareable link */}
      <div className="mb-4 flex items-center gap-2 rounded-[5px] border bg-background px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          link
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {shareLink}
        </span>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(shareLink)}
          className="text-muted-foreground hover:text-(--thread-accent-primary)"
          aria-label="copy link"
        >
          <CopyIcon className="size-3.5" />
        </button>
      </div>

      {/* Real amount/target + progress */}
      <div className="rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="font-mono text-muted-foreground text-xs">
            what will be paid
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-[1px]",
                detail.ready ? "bg-(--thread-accent-primary)" : "bg-amber-500",
              )}
            />
            {detail.signed.length}/{detail.threshold} signed
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-[5px] border bg-background p-4">
          <div className="flex items-center gap-2">
            <CoinsIcon className="size-4 text-(--thread-accent-primary)" />
            <span className="font-semibold text-lg tabular-nums">
              {detail.decoded.amountCspr ?? "—"}
            </span>
            <span className="font-mono text-muted-foreground text-xs">CSPR</span>
          </div>
          <div className="flex items-start gap-2">
            <TargetIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="break-all font-mono text-[11px] text-muted-foreground">
              {detail.decoded.target ?? "target not decoded"}
            </span>
          </div>
          {detail.description && (
            <p className="text-sm text-muted-foreground">{detail.description}</p>
          )}

          <div className="mt-1 border-t border-dashed border-border pt-2" />
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            signers ({detail.threshold} required)
          </span>
          {detail.requiredSigners.map((s) => {
            const done = detail.signed.includes(norm(s.publicKeyHex));
            return (
              <div
                key={s.publicKeyHex}
                className="flex items-center justify-between gap-3"
              >
                <span className="font-mono text-[11px] text-muted-foreground">
                  {s.label ? `${s.label} · ` : ""}
                  {short(s.publicKeyHex)}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px]",
                    done
                      ? "text-(--thread-accent-primary)"
                      : "text-muted-foreground",
                  )}
                >
                  {done ? "signed ✓" : "pending"}
                </span>
              </div>
            );
          })}

          {detail.transactionHash && (
            <>
              <div className="mt-2 border-t border-dashed border-border" />
              <a
                href={`https://testnet.cspr.live/deploy/${detail.transactionHash}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 pt-1 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
              >
                <ExternalLinkIcon className="size-3" />
                view on explorer
              </a>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        {detail.ready && !terminal && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="default"
                  size="sm"
                  className="rounded-[5px] font-mono text-xs"
                  disabled={busy}
                />
              }
            >
              <SendIcon className="size-3.5" />
              broadcast
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit to the network?</AlertDialogTitle>
                <AlertDialogDescription>
                  Irreversible. Moves{" "}
                  <strong className="text-foreground">
                    {detail.decoded.amountCspr ?? "?"} CSPR
                  </strong>{" "}
                  to{" "}
                  <span className="break-all font-mono text-[11px]">
                    {detail.decoded.target ?? "target not decoded"}
                  </span>
                  .
                </AlertDialogDescription>
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
                  cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  render={
                    <Button
                      variant="default"
                      size="sm"
                      className="rounded-[5px] font-mono text-xs"
                    />
                  }
                  onClick={onBroadcast}
                >
                  <SendIcon className="size-3.5" />
                  confirm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {cancellable && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-[5px] font-mono text-xs"
                  disabled={busy}
                />
              }
            >
              <Trash2Icon className="size-3.5" />
              cancel request
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel request?</AlertDialogTitle>
                <AlertDialogDescription>
                  Invalidates the signature link. Signatures already
                  collected are discarded. This cannot be undone.
                </AlertDialogDescription>
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
                  onClick={onCancel}
                >
                  confirm cancellation
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {msg && (
        <div className="mt-4 flex items-center gap-2 rounded-[5px] border px-3 py-2">
          {broadcastUrl || msg.includes("✓") ? (
            <CheckCircle2Icon className="size-3.5 text-(--thread-accent-primary)" />
          ) : (
            <CircleAlertIcon className="size-3.5 text-(--thread-accent-secondary)" />
          )}
          <span className="font-mono text-xs">{msg}</span>
          {broadcastUrl && (
            <a
              href={broadcastUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
            >
              <ExternalLinkIcon className="size-3" />
              explorer
            </a>
          )}
        </div>
      )}
    </main>
  );
}
