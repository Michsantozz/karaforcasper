"use client";

import { useState } from "react";
import {
  Wallet,
  Link2,
  Unlink,
  PenLine,
  Send,
  KeyRound,
  ShieldCheck,
  CircleAlert,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import { useCasperWallet } from "@/features/wallet/model/useCasperWallet";

// Page de teste ao vivo da Casper Wallet extension. Rota: /wallet-test
export default function WalletTestPage() {
  const wallet = useCasperWallet();
  const [signResult, setSignResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSignMessage = async () => {
    setBusy(true);
    setSignResult(null);
    const sig = await wallet.signMessage("Teste de assinatura — Casper Agent");
    setSignResult(sig ? `signatureHex: ${sig}` : "(cancelado / erro)");
    setBusy(false);
  };

  // Monta um Native Transfer real (não envia) e pede assinatura à extensão.
  // Usa buildFor1_5() → Deploy: formato que a Casper Wallet assina.
  const onSignTransfer = async () => {
    setBusy(true);
    setSignResult(null);
    try {
      const { NativeTransferBuilder, PublicKey, CasperNetworkName, Deploy } =
        await import("casper-js-sdk");

      if (!wallet.activeKey) throw new Error("Sem activeKey");

      const sender = PublicKey.fromHex(wallet.activeKey);
      const tx = new NativeTransferBuilder()
        .from(sender)
        .target(sender)
        .amount("2500000000") // 2.5 CSPR em motes
        .id(1)
        .chainName(CasperNetworkName.Testnet)
        .payment(100_000_000)
        .buildFor1_5();

      const deploy = tx.getDeploy();
      if (!deploy) throw new Error("Transaction não gerou Deploy");

      const json = JSON.stringify(Deploy.toJSON(deploy));
      const sig = await wallet.sign(json);
      setSignResult(
        sig ? `transfer signatureHex: ${sig}` : "(cancelado / erro)",
      );
    } catch (e) {
      setSignResult(
        "Erro ao montar/assinar: " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      {/* Hero */}
      <header className="mb-6 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-[5px] border bg-background">
          <Wallet className="size-4 text-(--thread-accent-primary)" />
        </span>
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Casper Wallet
          </h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            wallet-test / live integration
          </p>
        </div>
      </header>

      {/* Outer frame — duplo nesting */}
      <div className="rounded-[8px] bg-(--thread-frame-outer) p-1">
        {/* Header bar mono */}
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
            <Link2 className="size-3.5" />
            connection
          </span>
          <StatusPill
            connected={wallet.connected}
            installed={wallet.installed}
            locked={wallet.locked}
          />
        </div>

        {/* Inner card — status grid */}
        <div className="rounded-[5px] border bg-background p-4">
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="extension"
              value={wallet.installed ? "detected" : "missing"}
              positive={wallet.installed}
            />
            <Stat
              label="connected"
              value={wallet.connected ? "yes" : "no"}
              positive={wallet.connected}
            />
            <Stat
              label="locked"
              value={wallet.locked ? "yes" : "no"}
              positive={!wallet.locked}
            />
          </div>

          {/* Active key */}
          <div className="mt-3 flex items-center gap-2 rounded-[5px] border bg-background px-3 py-2">
            <KeyRound className="size-3.5 text-muted-foreground" />
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              active key
            </span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-xs">
              {wallet.activeKey ?? "—"}
            </span>
          </div>

          {wallet.error && (
            <div className="mt-3 flex items-center gap-2 rounded-[5px] border border-(--thread-accent-secondary) bg-(--thread-accent-secondary-soft) px-3 py-2">
              <CircleAlert className="size-3.5 text-(--thread-accent-secondary)" />
              <span className="text-(--thread-accent-secondary) text-xs">
                {wallet.error}
              </span>
            </div>
          )}
        </div>
      </div>

      {!wallet.installed && (
        <p className="mt-3 font-mono text-[11px] text-(--thread-accent-secondary)">
          Casper Wallet não detectada — instale a extensão e recarregue.
        </p>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-[5px] font-mono text-xs"
          onClick={wallet.connect}
          disabled={!wallet.installed}
        >
          <Link2 className="size-3.5" />
          {wallet.connected ? "reconnect" : "connect"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-[5px] font-mono text-xs"
          onClick={wallet.disconnect}
          disabled={!wallet.connected}
        >
          <Unlink className="size-3.5" />
          disconnect
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-[5px] font-mono text-xs"
          onClick={onSignMessage}
          disabled={!wallet.connected || busy}
        >
          <PenLine className="size-3.5" />
          sign message
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-[5px] font-mono text-xs"
          onClick={onSignTransfer}
          disabled={!wallet.connected || busy}
        >
          <Send className="size-3.5" />
          sign transfer · 2.5 CSPR
        </Button>
      </div>

      {/* Result */}
      {signResult && (
        <div className="mt-4 rounded-[8px] bg-(--thread-frame-outer) p-1">
          <div className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-muted-foreground text-xs">
            <ShieldCheck className="size-3.5" />
            signature output
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[5px] border bg-background p-4 font-mono text-xs">
            {signResult}
          </pre>
        </div>
      )}
    </main>
  );
}

function StatusPill({
  connected,
  installed,
  locked,
}: {
  connected: boolean;
  installed: boolean;
  locked: boolean;
}) {
  const { label, accent } = !installed
    ? { label: "no extension", accent: "secondary" as const }
    : locked
      ? { label: "locked", accent: "secondary" as const }
      : connected
        ? { label: "live", accent: "primary" as const }
        : { label: "idle", accent: "muted" as const };

  const dot =
    accent === "primary"
      ? "bg-(--thread-accent-primary) animate-pulse"
      : accent === "secondary"
        ? "bg-(--thread-accent-secondary)"
        : "bg-muted-foreground";

  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <span className={`size-1.5 rounded-[1px] ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

function Stat({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[5px] border bg-background p-3">
      <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="flex items-center gap-1.5 font-mono text-sm tabular-nums">
        <span
          className={`size-2 rounded-[1px] ${
            positive
              ? "bg-(--thread-accent-primary)"
              : "bg-(--thread-accent-secondary)"
          }`}
          aria-hidden
        />
        {value}
      </span>
    </div>
  );
}
