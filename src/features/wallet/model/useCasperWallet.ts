"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CasperWalletProvider,
  CasperWalletState,
} from "./types";

// Timeout for requests to the extension (30 min — official default).
const REQUESTS_TIMEOUT_MS = 30 * 60 * 1000;

export interface UseCasperWallet {
  /** Extension installed? (only known after mount, client-side) */
  installed: boolean;
  connected: boolean;
  locked: boolean;
  /** Public key hex of the active account, or null. */
  activeKey: string | null;
  error: string | null;
  /** Opens the connection popup. Returns the connected activeKey, or null. */
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  /** Signs a deploy/transaction JSON (opens popup). Returns signatureHex or null if cancelled. */
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

  // Provider is recreated per call (cheap constructor); we keep it just for reuse.
  const providerRef = useRef<CasperWalletProvider | null>(null);
  const provider = () => {
    if (!providerRef.current) providerRef.current = getProvider();
    return providerRef.current;
  };

  // Detects the extension + syncs initial state + listens for events.
  useEffect(() => {
    // Extension detection is only possible client-side (window.CasperWalletProvider);
    // syncing the wallet's presence/state is mount-time I/O, not render-derivable.
    const p = getProvider();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstalled(p !== null);
    if (!p) return;
    providerRef.current = p;

    // Initial state.
    p.isConnected()
      .then(async (isConn) => {
        setConnected(isConn);
        if (isConn) {
          try {
            const key = await p.getActivePublicKey();
            setActiveKey(key);
            setLocked(false);
          } catch {
            // getActivePublicKey throws when locked.
            setLocked(true);
          }
        }
      })
      .catch(() => {});

    // Extension events. event.detail is a JSON string with CasperWalletState.
    const types = window.CasperWalletEventTypes;
    if (!types) return;

    const apply = (raw: string) => {
      try {
        const state = JSON.parse(raw) as CasperWalletState;
        setConnected(state.isConnected);
        setLocked(state.isLocked);
        setActiveKey(state.activeKey);
      } catch {
        /* ignore malformed payload */
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
      setError("Casper Wallet extension not installed.");
      return null;
    }
    try {
      const ok = await p.requestConnection();
      if (!ok) {
        setError("Connection refused.");
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
        setError("Wallet not connected.");
        return null;
      }
      try {
        const res = await p.sign(deployJson, activeKey);
        if (res.cancelled) {
          setError("Signature cancelled.");
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
        setError("Wallet not connected.");
        return null;
      }
      try {
        const res = await p.signMessage(message, activeKey);
        if (res.cancelled) {
          setError("Signature cancelled.");
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
