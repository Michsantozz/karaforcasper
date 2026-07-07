"use client";

import type { CasperWalletProvider } from "./types";

// Timeout das requisições à extensão (30 min — default oficial).
const REQUESTS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Acesso ao provider injetado pela extensão, fora do ciclo React. Usado pelos
 * `execute` das frontend tools (connect_wallet/sign_with_wallet), que rodam no
 * browser quando o modelo chama a tool mas não têm acesso a hooks.
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

/** Abre o popup de conexão da extensão e retorna a conta ativa. */
export async function connectWallet(): Promise<ConnectOutcome> {
  const p = getCasperWalletProvider();
  if (!p)
    return {
      connected: false,
      activeKey: null,
      error: "Casper Wallet não instalada.",
    };
  try {
    const ok = await p.requestConnection();
    if (!ok)
      return { connected: false, activeKey: null, error: "Conexão recusada." };
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
 * Assina uma mensagem arbitrária (texto) com a conta dada. Usado na prova de
 * posse do vínculo de carteira: o usuário assina o nonce emitido pelo backend.
 * A extensão prefixa "Casper Message:\n" internamente — passa-se o nonce cru.
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
      error: "Casper Wallet não instalada.",
    };
  try {
    const res = await p.signMessage(message, signerPublicKeyHex);
    if (res.cancelled)
      return { signed: false, signatureHex: null, error: "Assinatura cancelada." };
    return { signed: true, signatureHex: res.signatureHex };
  } catch (e) {
    return {
      signed: false,
      signatureHex: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Abre o popup de assinatura para o deploy/tx JSON com a conta dada. */
export async function signWithWallet(
  deployJson: string,
  signerPublicKeyHex: string,
): Promise<SignOutcome> {
  const p = getCasperWalletProvider();
  if (!p)
    return {
      signed: false,
      signatureHex: null,
      error: "Casper Wallet não instalada.",
    };
  try {
    const res = await p.sign(deployJson, signerPublicKeyHex);
    if (res.cancelled)
      return { signed: false, signatureHex: null, error: "Assinatura cancelada." };
    return { signed: true, signatureHex: res.signatureHex };
  } catch (e) {
    return {
      signed: false,
      signatureHex: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
