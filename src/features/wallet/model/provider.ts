"use client";

import type { CasperWalletProvider } from "./types";

// Timeout for requests to the extension (30 min — official default).
const REQUESTS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Access to the provider injected by the extension, outside the React cycle.
 * Used by the `execute` of frontend tools (connect_wallet/sign_with_wallet),
 * which run in the browser when the model calls the tool but have no access
 * to hooks.
 */
export function getCasperWalletProvider(): CasperWalletProvider | null {
  if (typeof window === "undefined") return null;
  const ctor = window.CasperWalletProvider;
  if (!ctor) return null;
  return ctor({ timeout: REQUESTS_TIMEOUT_MS });
}

export interface ConnectOutcome {
  connected: boolean;
  activeKey: string | null;
  error?: string;
}

/** Opens the extension's connection popup and returns the active account. */
export async function connectWallet(): Promise<ConnectOutcome> {
  const p = getCasperWalletProvider();
  if (!p)
    return {
      connected: false,
      activeKey: null,
      error: "Casper Wallet not installed.",
    };
  try {
    const ok = await p.requestConnection();
    if (!ok)
      return { connected: false, activeKey: null, error: "Connection refused." };
    const activeKey = await p.getActivePublicKey();
    return { connected: true, activeKey };
  } catch (e) {
    return {
      connected: false,
      activeKey: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface SignOutcome {
  signed: boolean;
  signatureHex: string | null;
  error?: string;
}

/**
 * Signs an arbitrary message (text) with the given account. Used in the wallet
 * link's proof of possession: the user signs the nonce issued by the backend.
 * The extension prefixes "Casper Message:\n" internally — the raw nonce is passed.
 */
export async function signMessageWithWallet(
  message: string,
  signerPublicKeyHex: string,
): Promise<SignOutcome> {
  const p = getCasperWalletProvider();
  if (!p)
    return {
      signed: false,
      signatureHex: null,
      error: "Casper Wallet not installed.",
    };
  try {
    const res = await p.signMessage(message, signerPublicKeyHex);
    if (res.cancelled)
      return { signed: false, signatureHex: null, error: "Signature cancelled." };
    return { signed: true, signatureHex: res.signatureHex };
  } catch (e) {
    return {
      signed: false,
      signatureHex: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Opens the signing popup for the deploy/tx JSON with the given account. */
export async function signWithWallet(
  deployJson: string,
  signerPublicKeyHex: string,
): Promise<SignOutcome> {
  const p = getCasperWalletProvider();
  if (!p)
    return {
      signed: false,
      signatureHex: null,
      error: "Casper Wallet not installed.",
    };
  try {
    const res = await p.sign(deployJson, signerPublicKeyHex);
    if (res.cancelled)
      return { signed: false, signatureHex: null, error: "Signature cancelled." };
    return { signed: true, signatureHex: res.signatureHex };
  } catch (e) {
    return {
      signed: false,
      signatureHex: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
