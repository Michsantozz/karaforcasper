"use client";

import { use, useCallback, useState } from "react";
import {
  UsersIcon,
  KeyRoundIcon,
  PenLineIcon,
  Link2Icon,
  CircleAlertIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  SendIcon,
  LoaderIcon,
  CoinsIcon,
  TargetIcon,
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
import { signWithWallet } from "@/features/wallet/model/provider";
import { useSession } from "@/features/auth/model/auth-client";
import {
  useRequestDetail,
  useApproveRequest,
  useBroadcastRequest,
} from "@/features/multisig/model/queries";
import { cn } from "@/shared/lib/utils";

function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function norm(hex: string) {
  return hex.trim().toLowerCase();
}

/**
 * Página pública do link /sign/:id — o coração do fluxo de coleta distribuída.
 *
 * Mostra a tx (valor/destino via descrição + signatários + progresso). O
 * signatário conecta a carteira, assina pela própria conta (popup), e a
 * assinatura é enviada ao /approve. Se quórum atingido e o viewer é o criador,
 * mostra o botão de broadcast.
 */
export default function SignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const wallet = useCasperWallet();
  const { data: session } = useSession();

  const [msg, setMsg] = useState<string | null>(null);
  const [broadcastUrl, setBroadcastUrl] = useState<string | null>(null);

  // Detalhe + polling terminal-aware do hook compartilhado. O fetcher joga
  // Error("<status> ...") em resposta não-ok, então distinguimos 404 (request
  // inexistente/expirada) de falha de rede pela mensagem.
  const {
    data: detail,
    isLoading: loading,
    error,
    refetch,
  } = useRequestDetail(id);
  const loadError: "network" | "not_found" | null = error
    ? error.message.startsWith("404")
      ? "not_found"
      : "network"
    : null;

  const approveMut = useApproveRequest(id);
  const broadcastMut = useBroadcastRequest(id);
  const busy = approveMut.isPending || broadcastMut.isPending;

  // Conta ativa da carteira é um signatário exigido que ainda não assinou?
  const activeKey = wallet.activeKey ? norm(wallet.activeKey) : null;
  const required = detail?.requiredSigners.map((s) => norm(s.publicKeyHex)) ?? [];
  const isRequiredSigner = activeKey ? required.includes(activeKey) : false;
  const alreadySigned = activeKey
    ? (detail?.signed ?? []).includes(activeKey)
    : false;

  const onSign = useCallback(async () => {
    if (!detail || !wallet.activeKey) return;
    setMsg(null);
    try {
      // Assinatura na carteira (popup) roda no client — não é uma mutation.
      const out = await signWithWallet(detail.transactionJson, wallet.activeKey);
      if (!out.signed || !out.signatureHex) {
        setMsg(out.error ?? "Assinatura cancelada.");
        return;
      }
      // Registro no servidor via mutation (invalida detalhe + listas ao ok).
      const { ok, status, data } = await approveMut.mutateAsync({
        signerPublicKeyHex: wallet.activeKey,
        signatureHex: out.signatureHex,
      });
      if (!ok) {
        const err = data as {
          error?: string;
          issues?: { path: string; message: string }[];
        };
        const extra = err.issues?.length
          ? ` (${err.issues.map((i) => `${i.path}: ${i.message}`).join("; ")})`
          : "";
        setMsg(`Falha ao registrar: ${err.error ?? status}${extra}`);
        return;
      }
      setMsg("Assinatura registrada ✓");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [detail, wallet.activeKey, approveMut]);

  const onBroadcast = useCallback(async () => {
    setMsg(null);
    try {
      const { ok, status, data } = await broadcastMut.mutateAsync();
      const d = data as { error?: string; explorerUrl?: string };
      if (!ok) {
        const map: Record<string, string> = {
          forbidden: "Só o criador pode submeter.",
          request_not_ready: "Quórum ainda não atingido.",
          unauthenticated: "Faça login para submeter.",
        };
        setMsg(map[d.error ?? ""] ?? `Falha no broadcast: ${d.error ?? status}`);
        return;
      }
      setBroadcastUrl(d.explorerUrl ?? null);
      setMsg("Transação submetida ✓");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [broadcastMut]);

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <div className="flex items-center gap-2 font-mono text-muted-foreground text-sm">
          <LoaderIcon className="size-4 animate-spin" />
          carregando solicitação…
        </div>
      </main>
    );
  }

  if (!detail) {
    const isNetwork = loadError === "network";
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <div className="flex items-center gap-2 rounded-[5px] border border-(--thread-accent-secondary) bg-(--thread-accent-secondary-soft) px-3 py-2">
          <CircleAlertIcon className="size-4 text-(--thread-accent-secondary)" />
          <span className="text-(--thread-accent-secondary) text-sm">
            {isNetwork
              ? "Falha de rede ao carregar. Verifique a conexão."
              : "Solicitação não encontrada ou expirada."}
          </span>
          {isNetwork && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto rounded-[5px] font-mono text-xs"
              onClick={() => void refetch()}
            >
              tentar de novo
            </Button>
          )}
        </div>
      </main>
    );
  }

  const terminal = ["broadcast", "confirmed", "cancelled", "expired"].includes(
    detail.status,
  );

  // Heurística anti-engano: se a descrição cita um número de CSPR que não bate
  // com o valor real decodado, avisa o signatário. Best-effort (não bloqueia).
  const divergenceWarning = (() => {
    const real = detail.decoded.amountCspr;
    const desc = detail.description;
    if (!real || !desc) return null;
    const nums = desc.match(/\d[\d.,]*/g);
    if (!nums) return null;
    const realNum = Number(real);
    const mentionsReal = nums.some((n) => {
      const v = Number(n.replace(/,/g, ""));
      return Number.isFinite(v) && Math.abs(v - realNum) < 0.000001;
    });
    return mentionsReal
      ? null
      : `A descrição não bate com o valor real (${real} CSPR). Confie no valor acima, não na descrição.`;
  })();

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-[5px] border bg-background">
          <UsersIcon className="size-4 text-(--thread-accent-primary)" />
        </span>
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Assinatura multisig
          </h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            sign / {detail.id}
          </p>
        </div>
      </header>

      {/* Frame: detalhes da request */}
      <div className="rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="font-mono text-muted-foreground text-xs">
            {detail.kind} · {detail.chainName}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-[1px]",
                detail.ready
                  ? "bg-(--thread-accent-primary)"
                  : "bg-amber-500",
              )}
            />
            {detail.signed.length}/{detail.threshold} signed · {detail.status}
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-[5px] border bg-background p-4">
          {/* Valor/destino REAIS decodados da tx no servidor — a fonte de
              verdade do que está sendo assinado, independente da description. */}
          <div className="flex flex-col gap-2 rounded-[5px] border border-(--thread-accent-primary)/30 bg-(--thread-accent-primary)/5 p-3">
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              você está assinando
            </span>
            <div className="flex items-center gap-2">
              <CoinsIcon className="size-4 text-(--thread-accent-primary)" />
              <span className="font-semibold text-lg tabular-nums">
                {detail.decoded.amountCspr ?? "—"}
              </span>
              <span className="font-mono text-muted-foreground text-xs">
                CSPR
              </span>
            </div>
            <div className="flex items-start gap-2">
              <TargetIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="break-all font-mono text-[11px] text-muted-foreground">
                {detail.decoded.target ?? "destino não decodado"}
              </span>
            </div>
          </div>

          {detail.description && (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                descrição do criador
              </span>
              <p className="text-sm">{detail.description}</p>
              {divergenceWarning && (
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-(--thread-accent-secondary)">
                  <CircleAlertIcon className="size-3.5" />
                  {divergenceWarning}
                </span>
              )}
            </div>
          )}
          <div className="mt-1 border-t border-dashed border-border pt-2" />
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
            signatários ({detail.threshold} exigidas)
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

      {/* Carteira + ações */}
      <div className="mt-4 flex items-center gap-2 rounded-[5px] border bg-background px-3 py-2">
        <KeyRoundIcon className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          active key
        </span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-xs">
          {wallet.activeKey ?? "—"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {!wallet.connected ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-[5px] font-mono text-xs"
            onClick={wallet.connect}
            disabled={!wallet.installed}
          >
            <Link2Icon className="size-3.5" />
            conectar carteira
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="rounded-[5px] font-mono text-xs"
            onClick={onSign}
            disabled={
              busy || terminal || !isRequiredSigner || alreadySigned
            }
          >
            {busy ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <PenLineIcon className="size-3.5" />
            )}
            {alreadySigned
              ? "já assinou"
              : isRequiredSigner
                ? "assinar"
                : "conta não é signatária"}
          </Button>
        )}

        {!terminal && !isRequiredSigner && !alreadySigned && (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            A conta conectada não está na lista de signatários desta solicitação.
            Troque de conta na extensão da Casper Wallet e recarregue.
          </p>
        )}

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
                <AlertDialogTitle>Submeter à rede?</AlertDialogTitle>
                <AlertDialogDescription>
                  Esta ação é irreversível. A transação será transmitida à
                  Casper {detail.chainName} e moverá{" "}
                  <strong className="text-foreground">
                    {detail.decoded.amountCspr ?? "?"} CSPR
                  </strong>{" "}
                  para{" "}
                  <span className="break-all font-mono text-[11px]">
                    {detail.decoded.target ?? "destino não decodado"}
                  </span>
                  . Não há como desfazer.
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
                  cancelar
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
                  confirmar broadcast
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {!wallet.installed && (
        <p className="mt-3 font-mono text-[11px] text-(--thread-accent-secondary)">
          Casper Wallet não detectada —{" "}
          <a
            href="https://www.casperwallet.io/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            instale a extensão
          </a>{" "}
          e recarregue a página.
        </p>
      )}

      {(msg || wallet.error) && (
        <div className="mt-4 flex items-center gap-2 rounded-[5px] border px-3 py-2">
          {broadcastUrl || msg?.includes("✓") ? (
            <CheckCircle2Icon className="size-3.5 text-(--thread-accent-primary)" />
          ) : (
            <CircleAlertIcon className="size-3.5 text-(--thread-accent-secondary)" />
          )}
          <span className="font-mono text-xs">{msg ?? wallet.error}</span>
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

      {session?.user && (
        <p className="mt-4 font-mono text-[10px] text-muted-foreground">
          logado como {session.user.email}
        </p>
      )}
    </main>
  );
}
