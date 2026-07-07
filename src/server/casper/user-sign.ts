import "server-only";
import {
  NativeTransferBuilder,
  NativeDelegateBuilder,
  NativeUndelegateBuilder,
  Transaction,
  PublicKey,
} from "casper-js-sdk";
import { Buffer } from "node:buffer";
import { CHAIN_NAME, getRpc } from "./client";

const MOTES_PER_CSPR = 1_000_000_000n;
// Gas de payment p/ transfer nativo no Testnet (~0.1 CSPR).
const TRANSFER_PAYMENT_MOTES = 100_000_000;
// Gas de payment p/ delegate/undelegate (~2.5 CSPR — operação de auction).
const STAKING_PAYMENT_MOTES = 2_500_000_000;

function toMotes(amountCspr: number): string {
  return BigInt(Math.round(amountCspr * Number(MOTES_PER_CSPR))).toString();
}

// Tag de algoritmo (= prefixo da public key): 01 = ED25519, 02 = SECP256K1.
// A Casper Wallet retorna a assinatura crua (64 bytes); o nó exige a tag no
// primeiro byte. Prefixa-a se ainda não estiver presente (idempotente).
export function withAlgorithmTag(
  signatureHex: string,
  signerPublicKeyHex: string,
): Uint8Array {
  const raw = Uint8Array.from(Buffer.from(signatureHex, "hex"));
  const tag = signerPublicKeyHex.slice(0, 2).toLowerCase() === "01" ? 0x01 : 0x02;
  // 64 bytes = assinatura crua (precisa de tag); 65 = já prefixada.
  if (raw.length === 65 && (raw[0] === 0x01 || raw[0] === 0x02)) return raw;
  const tagged = new Uint8Array(raw.length + 1);
  tagged[0] = tag;
  tagged.set(raw, 1);
  return tagged;
}

export interface PreparedUserTransfer {
  /** JSON da tx (sem assinatura) — enviado ao client p/ a Casper Wallet assinar. */
  transactionJson: string;
  /** Public key (hex) que DEVE assinar — a conta ativa na carteira do usuário. */
  signerPublicKeyHex: string;
  amountCspr: string;
  to: string;
  chainName: string;
}

/**
 * Monta um transfer nativo de CSPR a partir da carteira do USUÁRIO (não a do
 * agente) — sem assinar. O JSON resultante vai ao browser, onde a extensão
 * Casper Wallet assina (popup). A assinatura volta e é anexada em
 * broadcastUserSignedTransfer.
 */
export function prepareUserTransfer(args: {
  fromPublicKeyHex: string;
  toPublicKeyHex: string;
  amountCspr: number;
  transferId?: number;
}): PreparedUserTransfer {
  const from = PublicKey.fromHex(args.fromPublicKeyHex);
  const target = PublicKey.fromHex(args.toPublicKeyHex);

  const tx = new NativeTransferBuilder()
    .from(from)
    .target(target)
    .amount(toMotes(args.amountCspr))
    .id(args.transferId ?? Date.now() % 1_000_000)
    .chainName(CHAIN_NAME)
    .payment(TRANSFER_PAYMENT_MOTES)
    .build();

  return {
    transactionJson: JSON.stringify(tx.toJSON()),
    signerPublicKeyHex: args.fromPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    to: args.toPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

export interface PreparedUserStaking {
  /** JSON da tx (sem assinatura) — enviado ao client p/ a carteira assinar. */
  transactionJson: string;
  signerPublicKeyHex: string;
  amountCspr: string;
  /** Public key do validador (delegate/undelegate). */
  validator: string;
  chainName: string;
}

/**
 * Monta (sem assinar) uma delegação de CSPR da carteira do USUÁRIO a um
 * validador. Stakear gera recompensas. O JSON vai ao browser p/ assinatura.
 */
export function prepareUserDelegate(args: {
  fromPublicKeyHex: string;
  validatorPublicKeyHex: string;
  amountCspr: number;
}): PreparedUserStaking {
  const from = PublicKey.fromHex(args.fromPublicKeyHex);
  const validator = PublicKey.fromHex(args.validatorPublicKeyHex);

  const tx = new NativeDelegateBuilder()
    .from(from)
    .validator(validator)
    .amount(toMotes(args.amountCspr))
    .chainName(CHAIN_NAME)
    .payment(STAKING_PAYMENT_MOTES)
    .build();

  return {
    transactionJson: JSON.stringify(tx.toJSON()),
    signerPublicKeyHex: args.fromPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    validator: args.validatorPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

/**
 * Monta (sem assinar) o resgate (undelegate) de CSPR previamente stakeado da
 * carteira do USUÁRIO num validador. O JSON vai ao browser p/ assinatura.
 */
export function prepareUserUndelegate(args: {
  fromPublicKeyHex: string;
  validatorPublicKeyHex: string;
  amountCspr: number;
}): PreparedUserStaking {
  const from = PublicKey.fromHex(args.fromPublicKeyHex);
  const validator = PublicKey.fromHex(args.validatorPublicKeyHex);

  const tx = new NativeUndelegateBuilder()
    .from(from)
    .validator(validator)
    .amount(toMotes(args.amountCspr))
    .chainName(CHAIN_NAME)
    .payment(STAKING_PAYMENT_MOTES)
    .build();

  return {
    transactionJson: JSON.stringify(tx.toJSON()),
    signerPublicKeyHex: args.fromPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    validator: args.validatorPublicKeyHex,
    chainName: CHAIN_NAME,
  };
}

export interface BroadcastResult {
  transactionHash: string;
  explorerUrl: string;
}

/**
 * Recebe o JSON da tx (mesmo que prepareUserTransfer emitiu) + a assinatura
 * hex produzida pela carteira do usuário. Anexa a approval e submete on-chain.
 */
export async function broadcastUserSignedTransfer(args: {
  transactionJson: string;
  signatureHex: string;
  signerPublicKeyHex: string;
}): Promise<BroadcastResult> {
  const tx = Transaction.fromJSON(JSON.parse(args.transactionJson));
  const signer = PublicKey.fromHex(args.signerPublicKeyHex);

  // A Casper Wallet devolve a assinatura CRUA (64 bytes, sem o byte de
  // algoritmo). O nó/SDK esperam a assinatura prefixada com a tag da curva:
  // 01 = ED25519, 02 = SECP256K1 — a mesma tag que prefixa a public key.
  const sig = withAlgorithmTag(args.signatureHex, args.signerPublicKeyHex);
  tx.setSignature(sig, signer);

  const res = await getRpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  return {
    transactionHash: hash,
    explorerUrl: `https://testnet.cspr.live/deploy/${hash}`,
  };
}
