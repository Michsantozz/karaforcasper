// Casper Wallet extension types. The extension injects `CasperWalletProvider`
// and `CasperWalletEventTypes` into `window` — no npm package is required.
// Source: https://github.com/make-software/casper-wallet docs (injected SDK).

export interface CasperWalletProvider {
  /** Opens the connection popup. Resolves `true` if the user approved. */
  requestConnection(): Promise<boolean>;
  /** Requests re-authorization (even if already connected). */
  requestSwitchAccount(): Promise<boolean>;
  /** Disconnects the site from the wallet. */
  disconnectFromSite(): Promise<boolean>;
  /** Public key (hex) of the active account. Throws if the wallet is locked. */
  getActivePublicKey(): Promise<string>;
  /** Is the site connected to the wallet? */
  isConnected(): Promise<boolean>;
  /** Extension version. */
  getVersion(): Promise<string>;
  /**
   * Signs a deploy/transaction (JSON string) with the `signingPublicKeyHex`
   * account. Opens the signing popup. Returns `{ cancelled }` or the signature.
   */
  sign(
    deployJson: string,
    signingPublicKeyHex: string,
  ): Promise<
    | { cancelled: true }
    | { cancelled: false; signatureHex: string; signature: Uint8Array }
  >;
  /** Signs an arbitrary message. */
  signMessage(
    message: string,
    signingPublicKeyHex: string,
  ): Promise<
    | { cancelled: true }
    | { cancelled: false; signatureHex: string; signature: Uint8Array }
  >;
}

export interface CasperWalletProviderOptions {
  /** Timeout (ms) for requests to the extension. Default 30min. */
  timeout?: number;
}

export type CasperWalletProviderConstructor = (
  options?: CasperWalletProviderOptions,
) => CasperWalletProvider;

/** Names of the events the extension fires on `window`. */
export interface CasperWalletEventTypes {
  connected: string;
  disconnected: string;
  tabChanged: string;
  activeKeyChanged: string;
  locked: string;
  unlocked: string;
}

/** Payload (JSON string in `event.detail`) of the wallet events. */
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
