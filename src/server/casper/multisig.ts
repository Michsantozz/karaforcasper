import "server-only";
import { NativeTransferBuilder, Transaction, PublicKey } from "casper-js-sdk";
import { CHAIN_NAME, getRpc } from "./client";
import { withAlgorithmTag } from "./user-sign";

const MOTES_PER_CSPR = 1_000_000_000n;
const TRANSFER_PAYMENT_MOTES = 100_000_000;

// Exportado para teste unitário (money math — precisão crítica).
export function toMotes(amountCspr: number): string {
  return BigInt(Math.round(amountCspr * Number(MOTES_PER_CSPR))).toString();
}

function norm(hex: string): string {
  return hex.trim().toLowerCase();
}

/**
 * Lê as public keys (hex) que já assinaram a tx, a partir do JSON.
 * Exportado para teste unitário.
 */
export function approvalSigners(transactionJson: string): string[] {
  try {
    const parsed = JSON.parse(transactionJson) as {
      approvals?: { signer?: string }[];
    };
    return (parsed.approvals ?? [])
      .map((a) => (a.signer ? norm(a.signer) : null))
      .filter((x): x is string => x !== null);
  } catch {
    return [];
  }
}

export interface MultisigState {
  transactionJson: string;
  /** Pagador (de onde saem os fundos) — também precisa estar em signers. */
  from: string;
  to: string;
  amountCspr: string;
  /** Todas as public keys que devem assinar. */
  signers: string[];
  /** Quantas assinaturas são necessárias para submeter (quórum). */
  threshold: number;
  /** Public keys que já assinaram. */
  signed: string[];
  /** Public keys que ainda faltam. */
  pending: string[];
  /** Pronto para broadcast? */
  ready: boolean;
  chainName: string;
}

// Exportado para teste unitário (decisão de quórum: ready = signed >= threshold).
export function buildState(
  transactionJson: string,
  meta: {
    from: string;
    to: string;
    amountCspr: string;
    signers: string[];
    threshold: number;
  },
): MultisigState {
  const signers = meta.signers.map(norm);
  const signed = approvalSigners(transactionJson).filter((s) =>
    signers.includes(s),
  );
  const pending = signers.filter((s) => !signed.includes(s));
  return {
    transactionJson,
    from: meta.from,
    to: meta.to,
    amountCspr: meta.amountCspr,
    signers,
    threshold: meta.threshold,
    signed,
    pending,
    ready: signed.length >= meta.threshold,
    chainName: CHAIN_NAME,
  };
}

/**
 * Monta (sem assinar) um pagamento que exige múltiplas assinaturas. A tx em si
 * é um transfer nativo do pagador `from`; as assinaturas dos demais signatários
 * são acumuladas como approvals antes do broadcast. `threshold` define o quórum
 * (padrão: todos).
 *
 * Nota: para a REDE aceitar N assinaturas de chaves distintas, a conta pagadora
 * precisa ter essas chaves associadas com weights (multisig de conta). Sem esse
 * setup, a tx carrega as N approvals (demonstrável on-chain) mas só a do dono
 * conta para o threshold da rede.
 */
export function prepareMultisigPayment(args: {
  fromPublicKeyHex: string;
  toPublicKeyHex: string;
  amountCspr: number;
  signerPublicKeysHex: string[];
  threshold?: number;
  transferId?: number;
}): MultisigState {
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

  // Garante o pagador entre os signatários.
  const signers = Array.from(
    new Set([norm(args.fromPublicKeyHex), ...args.signerPublicKeysHex.map(norm)]),
  );
  // Clamp: quórum entre 1 e o nº de signatários. Sem o piso de 1, um threshold
  // 0/negativo deixaria `ready` sempre true (broadcast sem assinatura). Mesmo
  // clamp de createSignatureRequest em signature-request.ts.
  const threshold = Math.min(
    Math.max(args.threshold ?? signers.length, 1),
    signers.length,
  );

  return buildState(JSON.stringify(tx.toJSON()), {
    from: args.fromPublicKeyHex,
    to: args.toPublicKeyHex,
    amountCspr: args.amountCspr.toString(),
    signers,
    threshold,
  });
}

/**
 * Anexa UMA assinatura (de sign_with_wallet) à tx multisig e devolve o estado
 * atualizado. Idempotente por signatário: re-assinar não duplica.
 */
export function addMultisigApproval(args: {
  transactionJson: string;
  signatureHex: string;
  signerPublicKeyHex: string;
  meta: {
    from: string;
    to: string;
    amountCspr: string;
    signers: string[];
    threshold: number;
  };
}): MultisigState {
  const already = approvalSigners(args.transactionJson);
  if (already.includes(norm(args.signerPublicKeyHex))) {
    return buildState(args.transactionJson, args.meta);
  }

  const tx = Transaction.fromJSON(JSON.parse(args.transactionJson));
  const signer = PublicKey.fromHex(args.signerPublicKeyHex);
  const sig = withAlgorithmTag(args.signatureHex, args.signerPublicKeyHex);
  tx.setSignature(sig, signer); // empilha em approvals[]

  return buildState(JSON.stringify(tx.toJSON()), args.meta);
}

export interface MultisigBroadcastResult {
  transactionHash: string;
  explorerUrl: string;
}

/** Submete a tx multisig (já com as approvals acumuladas) on-chain. */
export async function broadcastMultisig(
  transactionJson: string,
): Promise<MultisigBroadcastResult> {
  const tx = Transaction.fromJSON(JSON.parse(transactionJson));
  const res = await getRpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  return {
    transactionHash: hash,
    explorerUrl: `https://testnet.cspr.live/deploy/${hash}`,
  };
}
