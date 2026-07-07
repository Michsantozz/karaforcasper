import "server-only";
import {
  HttpHandler,
  RpcClient,
  PrivateKey,
  KeyAlgorithm,
} from "casper-js-sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Config do Testnet. Tudo vem de env (ver .env.example).
export const CHAIN_NAME = process.env.CASPER_CHAIN_NAME ?? "casper-test";
const NODE_URL =
  process.env.CASPER_NODE_URL ?? "https://node.testnet.casper.network/rpc";
// Fallback fora do repo (~/.casper/keys) — chave privada nunca mora na raiz do
// projeto (padrão do SDK oficial: pasta dedicada). Override via env.
const SECRET_KEY_PATH =
  process.env.CASPER_AGENT_SECRET_KEY_PATH ??
  join(homedir(), ".casper", "keys", "agent-secret.pem");

// RpcClient único reusado entre requests (HttpHandler com fetch).
let rpcClient: RpcClient | null = null;
export function getRpc(): RpcClient {
  if (!rpcClient) {
    rpcClient = new RpcClient(new HttpHandler(NODE_URL, "fetch"));
  }
  return rpcClient;
}

// Resolve o PEM da chave do agente. Precedência:
//   1. CASPER_AGENT_SECRET_KEY_PEM  — conteúdo do PEM direto em env (secret
//      mount de container: Docker/K8s secret injeta a env, sem arquivo em disco).
//      Aceita PEM cru ou base64 do PEM (\n em env é frágil; base64 é o modo robusto).
//   2. CASPER_AGENT_SECRET_KEY_PATH — arquivo .pem no disco (dev local, ~/.casper/keys).
// Fail-closed: se nenhum resolver, erra explícito em vez de assinar com chave errada.
async function readAgentPem(): Promise<string> {
  const inline = process.env.CASPER_AGENT_SECRET_KEY_PEM?.trim();
  if (inline) {
    // PEM válido começa com "-----BEGIN"; senão trata como base64 e decodifica.
    return inline.startsWith("-----BEGIN")
      ? inline
      : Buffer.from(inline, "base64").toString("utf8");
  }
  return readFile(SECRET_KEY_PATH, "utf8");
}

// Chave privada do agente, carregada do .pem uma vez.
let agentKey: PrivateKey | null = null;
export async function getAgentKey(): Promise<PrivateKey> {
  if (!agentKey) {
    const pem = await readAgentPem();
    // Curva da chave: SECP256K1 (Casper Wallet exporta EC PRIVATE KEY).
    // Override via env CASPER_KEY_ALGORITHM=ED25519 se usar chave ed25519.
    const algo =
      process.env.CASPER_KEY_ALGORITHM === "ED25519"
        ? KeyAlgorithm.ED25519
        : KeyAlgorithm.SECP256K1;
    agentKey = PrivateKey.fromPem(pem, algo);
  }
  return agentKey;
}

// Public key do agente em hex (endereço da carteira).
export async function getAgentPublicKeyHex(): Promise<string> {
  const key = await getAgentKey();
  return key.publicKey.toHex();
}
