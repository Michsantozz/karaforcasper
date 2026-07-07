"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CasperWalletProvider,
  CasperWalletState,
} from "./types";

// Timeout das requisições à extensão (30 min — default oficial).
const REQUESTS_TIMEOUT_MS = 30 * 60 * 1000;

export interface UseCasperWallet {
  /** Extensão instalada? (só conhecido após mount, no client) */
  installed: boolean;
  connected: boolean;
  locked: boolean;
  /** Chave pública hex da conta ativa, ou null. */
  activeKey: string | null;
  error: string | null;
  /** Abre o popup de conexão. Retorna a activeKey conectada, ou null. */
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  /** Assina um deploy/transaction JSON (abre popup). Retorna signatureHex ou null se cancelado. */
  sign: (deployJson: string) => Promise<string | null>;
  signMessage: (message: string) => Promise<string | null>;
}

function getProvider(): CasperWalletProvider | null {
  if (typeof window === "undefined") return null;
  const ctor = window.CasperWalletProvider;
  if (!ctor) return null;
  return ctor({ timeout: REQUESTS_TIMEOUT_MS });
}

export function useCasperWallet(): UseCasperWallet {
  const [installed, setInstalled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [locked, setLocked] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Provider é recriado por chamada (constructor barato); guardamos só pra reuso.
  const providerRef = useRef<CasperWalletProvider | null>(null);
  const provider = () => {
    if (!providerRef.current) providerRef.current = getProvider();
    return providerRef.current;
  };

  // Detecta extensão + sincroniza estado inicial + escuta eventos.
  useEffect(() => {
    // Detecção da extensão só é possível client-side (window.CasperWalletProvider);
    // sincronizar presença/estado da wallet é I/O de montagem, não render-derivable.
    const p = getProvider();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstalled(p !== null);
    if (!p) return;
    providerRef.current = p;

    // Estado inicial.
    p.isConnected()
      .then(async (isConn) => {
        setConnected(isConn);
        if (isConn) {
          try {
            const key = await p.getActivePublicKey();
            setActiveKey(key);
            setLocked(false);
          } catch {
            // getActivePublicKey lança quando locked.
            setLocked(true);
          }
        }
      })
      .catch(() => {});

    // Eventos da extensão. event.detail é JSON string com CasperWalletState.
    const types = window.CasperWalletEventTypes;
    if (!types) return;

    const apply = (raw: string) => {
      try {
        const state = JSON.parse(raw) as CasperWalletState;
        setConnected(state.isConnected);
        setLocked(state.isLocked);
        setActiveKey(state.activeKey);
      } catch {
        /* ignora payload malformado */
      }
    };
    const handler = (e: Event) => apply((e as CustomEvent<string>).detail);

    const names = [
      types.connected,
      types.disconnected,
      types.activeKeyChanged,
      types.locked,
      types.unlocked,
      types.tabChanged,
    ];
    names.forEach((n) => window.addEventListener(n, handler));
    return () => names.forEach((n) => window.removeEventListener(n, handler));
  }, []);

  const connect = useCallback(async (): Promise<string | null> => {
    setError(null);
    const p = provider();
    if (!p) {
      setError("Casper Wallet extension não instalada.");
      return null;
    }
    try {
      const ok = await p.requestConnection();
      if (!ok) {
        setError("Conexão recusada.");
        return null;
      }
      const key = await p.getActivePublicKey();
      setActiveKey(key);
      setConnected(true);
      setLocked(false);
      return key;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const disconnect = useCallback(async () => {
    setError(null);
    const p = provider();
    if (!p) return;
    try {
      await p.disconnectFromSite();
      setConnected(false);
      setActiveKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const sign = useCallback(
    async (deployJson: string): Promise<string | null> => {
      setError(null);
      const p = provider();
      if (!p || !activeKey) {
        setError("Carteira não conectada.");
        return null;
      }
      try {
        const res = await p.sign(deployJson, activeKey);
        if (res.cancelled) {
          setError("Assinatura cancelada.");
          return null;
        }
        return res.signatureHex;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [activeKey],
  );

  const signMessage = useCallback(
    async (message: string): Promise<string | null> => {
      setError(null);
      const p = provider();
      if (!p || !activeKey) {
        setError("Carteira não conectada.");
        return null;
      }
      try {
        const res = await p.signMessage(message, activeKey);
        if (res.cancelled) {
          setError("Assinatura cancelada.");
          return null;
        }
        return res.signatureHex;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [activeKey],
  );

  return {
    installed,
    connected,
    locked,
    activeKey,
    error,
    connect,
    disconnect,
    sign,
    signMessage,
  };
}
