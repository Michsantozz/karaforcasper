import "server-only";
import { createHash } from "node:crypto";
import { NativeTransferBuilder, PublicKey } from "casper-js-sdk";
import { CHAIN_NAME, getRpc, getAgentKey, getAgentPublicKeyHex } from "./client";

// Transfer para si mesmo, apenas como portador da impressão digital da ata no
// transfer id. A rede exige um valor mínimo de transferência (2.5 CSPR no
// Testnet) — como o destino é o próprio agente, o valor volta para ele.
const NOTARY_AMOUNT_MOTES = "2500000000"; // 2.5 CSPR (mínimo de transfer)
const NOTARY_PAYMENT_MOTES = 100_000_000; // ~0.1 CSPR de gas

/**
 * O transfer id é um U64 (8 bytes) — não cabe o SHA-256 inteiro (32 bytes).
 * Derivamos um id determinístico dos primeiros 8 bytes do hash: é o índice
 * on-chain que liga a tx à ata. O hash completo é determinístico e
 * reproduzível a partir da ata (hashMeetingRecord), então a verificação
 * recalcula o hash, deriva o mesmo id e confere contra o id ancorado.
 */
// Exportado para teste unitário (é lógica de decode on-chain crítica, não só
// interno). Não faz parte da API pública consumida por outras camadas.
export function hashToTransferId(meetingHash: string): number {
  // 13 hex dígitos ≈ 52 bits — cabe com folga em Number.MAX_SAFE_INTEGER.
  return Number.parseInt(meetingHash.slice(0, 13), 16);
}

/**
 * Decodifica o id ancorado: bytes "01<u64 little-endian>" (01 = Option::Some).
 * Inverte os 8 bytes do U64 e converte para number.
 */
// Exportado para teste unitário (decode de CLValue on-chain — crítico).
export function decodeOptionU64LE(bytesHex: string): number | null {
  // Remove o prefixo Option (01 = Some, 00 = None).
  if (!bytesHex || bytesHex.slice(0, 2).toLowerCase() === "00") return null;
  const le = bytesHex.slice(2); // 16 hex = 8 bytes U64
  const pairs = le.match(/.{2}/g);
  if (!pairs) return null;
  const beHex = pairs.reverse().join(""); // little-endian → big-endian
  return Number(BigInt("0x" + beHex));
}

/** Estrutura mínima da ata que será ancorada. */
export interface MeetingRecord {
  botId: string;
  summary: string | null;
  decisions?: string[];
  actionItems?: { task: string; owner: string | null }[];
  participants?: string[];
  topics?: string[];
}

/**
 * Serializa a ata de forma DETERMINÍSTICA (chaves ordenadas) e calcula o
 * SHA-256. Mesma ata → mesmo hash, independente da ordem dos campos — condição
 * para a verificação posterior funcionar.
 */
export function hashMeetingRecord(record: MeetingRecord): string {
  const canonical = JSON.stringify({
    actionItems: (record.actionItems ?? [])
      .map((a) => ({ owner: a.owner ?? "", task: a.task }))
      .sort((x, y) => (x.task < y.task ? -1 : x.task > y.task ? 1 : 0)),
    botId: record.botId,
    decisions: [...(record.decisions ?? [])].sort(),
    participants: [...(record.participants ?? [])].sort(),
    summary: record.summary ?? "",
    topics: [...(record.topics ?? [])].sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface NotarizeResult {
  meetingHash: string;
  transactionHash: string;
  notary: string;
  chainName: string;
  explorerUrl: string;
}

/**
 * Ancora a ata no Casper: monta um transfer mínimo (1 mote, para si mesmo) cujo
 * transfer id deriva do hash da ata, assina com a carteira DO AGENTE e submete.
 * Gera transação real (tx-producing) — a prova imutável de que a ata existiu
 * neste estado, ligada on-chain pelo id derivado.
 */
export async function notarizeMeeting(
  record: MeetingRecord,
): Promise<NotarizeResult> {
  const meetingHash = hashMeetingRecord(record);
  const key = await getAgentKey();
  const notary = await getAgentPublicKeyHex();
  const transferId = hashToTransferId(meetingHash);

  const tx = new NativeTransferBuilder()
    .from(key.publicKey)
    .target(PublicKey.fromHex(notary)) // para si mesmo: só ancora
    .amount(NOTARY_AMOUNT_MOTES)
    .id(transferId)
    .chainName(CHAIN_NAME)
    .payment(NOTARY_PAYMENT_MOTES)
    .build();

  tx.sign(key);
  const res = await getRpc().putTransaction(tx);
  const transactionHash = res.transactionHash.toHex();

  return {
    meetingHash,
    transactionHash,
    notary,
    chainName: CHAIN_NAME,
    explorerUrl: `https://testnet.cspr.live/deploy/${transactionHash}`,
  };
}

export interface VerifyResult {
  found: boolean;
  /** transfer id ancorado on-chain nesta tx (se encontrado). */
  anchoredId: number | null;
  /** id derivado da ata fornecida (se fornecida). */
  expectedId: number | null;
  /** Hash recalculado a partir da ata fornecida (se fornecida). */
  recomputedHash: string | null;
  /** true quando anchoredId === expectedId. */
  matches: boolean;
  transactionHash: string;
  explorerUrl: string;
}

/**
 * Verifica uma notarização: lê a transação on-chain pelo hash, extrai o
 * transfer id ancorado e, se a ata for fornecida, deriva o id esperado a partir
 * do hash recalculado e compara — provando (ou refutando) que aquela ata
 * corresponde ao registro on-chain.
 */
export async function verifyMeeting(args: {
  transactionHash: string;
  record?: MeetingRecord;
}): Promise<VerifyResult> {
  const explorerUrl = `https://testnet.cspr.live/deploy/${args.transactionHash}`;
  const recomputedHash = args.record ? hashMeetingRecord(args.record) : null;
  const expectedId = recomputedHash ? hashToTransferId(recomputedHash) : null;

  let anchoredId: number | null = null;
  try {
    const res = await getRpc().getTransactionByTransactionHash(
      args.transactionHash,
    );
    // O arg "id" do transfer serializa como ["id",{bytes:"01<u64 LE>",cl_type:
    // {Option:"U64"}}]. Extrai os bytes e decodifica o U64 little-endian
    // (primeiro byte 01 = Option::Some).
    const blob = JSON.stringify(res.transaction.toJSON());
    const m = /"id"\s*,\s*\{\s*"bytes"\s*:\s*"([0-9a-f]+)"/i.exec(blob);
    anchoredId = m ? decodeOptionU64LE(m[1]) : null;
  } catch {
    return {
      found: false,
      anchoredId: null,
      expectedId,
      recomputedHash,
      matches: false,
      transactionHash: args.transactionHash,
      explorerUrl,
    };
  }

  return {
    found: anchoredId !== null,
    anchoredId,
    expectedId,
    recomputedHash,
    matches:
      anchoredId !== null && expectedId !== null && anchoredId === expectedId,
    transactionHash: args.transactionHash,
    explorerUrl,
  };
}
