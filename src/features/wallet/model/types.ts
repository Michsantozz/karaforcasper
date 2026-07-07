// Tipos da Casper Wallet extension. A extensão injeta `CasperWalletProvider`
// e `CasperWalletEventTypes` no `window` — nenhum pacote npm é necessário.
// Fonte: https://github.com/make-software/casper-wallet docs (SDK injetado).

export interface CasperWalletProvider {
  /** Abre o popup pedindo conexão. Resolve `true` se o usuário aprovou. */
  requestConnection(): Promise<boolean>;
  /** Pede nova autorização (mesmo que já conectado). */
  requestSwitchAccount(): Promise<boolean>;
  /** Desconecta o site da carteira. */
  disconnectFromSite(): Promise<boolean>;
  /** Chave pública (hex) da conta ativa. Lança se a carteira estiver locked. */
  getActivePublicKey(): Promise<string>;
  /** Site está conectado à carteira? */
  isConnected(): Promise<boolean>;
  /** Versão da extensão. */
  getVersion(): Promise<string>;
  /**
   * Assina um deploy/transaction (JSON string) com a conta `signingPublicKeyHex`.
   * Abre o popup de assinatura. Retorna `{ cancelled }` ou a assinatura.
   */
  sign(
    deployJson: string,
    signingPublicKeyHex: string,
  ): Promise<
    | { cancelled: true }
    | { cancelled: false; signatureHex: string; signature: Uint8Array }
  >;
  /** Assina uma mensagem arbitrária. */
  signMessage(
    message: string,
    signingPublicKeyHex: string,
  ): Promise<
    | { cancelled: true }
    | { cancelled: false; signatureHex: string; signature: Uint8Array }
  >;
}

export interface CasperWalletProviderOptions {
  /** Timeout (ms) das requisições à extensão. Default 30min. */
  timeout?: number;
}

export type CasperWalletProviderConstructor = (
  options?: CasperWalletProviderOptions,
) => CasperWalletProvider;

/** Nomes dos eventos disparados pela extensão no `window`. */
export interface CasperWalletEventTypes {
  connected: string;
  disconnected: string;
  tabChanged: string;
  activeKeyChanged: string;
  locked: string;
  unlocked: string;
}

/** Payload (JSON string em `event.detail`) dos eventos da carteira. */
export interface CasperWalletState {
  isLocked: boolean;
  isConnected: boolean;
  activeKey: string | null;
}

declare global {
  interface Window {
    CasperWalletProvider?: CasperWalletProviderConstructor;
    CasperWalletEventTypes?: CasperWalletEventTypes;
  }
}
