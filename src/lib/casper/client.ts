import "server-only";
import {
  HttpHandler,
  RpcClient,
  PrivateKey,
  KeyAlgorithm,
} from "casper-js-sdk";
import { readFile } from "node:fs/promises";

// Config do Testnet. Tudo vem de env (ver .env.example).
export const CHAIN_NAME = process.env.CASPER_CHAIN_NAME ?? "casper-test";
const NODE_URL =
  process.env.CASPER_NODE_URL ?? "https://node.testnet.casper.network/rpc";
const SECRET_KEY_PATH =
  process.env.CASPER_AGENT_SECRET_KEY_PATH ?? "./agent-secret.pem";

// RpcClient único reusado entre requests (HttpHandler com fetch).
let rpcClient: RpcClient | null = null;
export function getRpc(): RpcClient {
  if (!rpcClient) {
    rpcClient = new RpcClient(new HttpHandler(NODE_URL, "fetch"));
  }
  return rpcClient;
}

// Chave privada do agente, carregada do .pem uma vez.
let agentKey: PrivateKey | null = null;
export async function getAgentKey(): Promise<PrivateKey> {
  if (!agentKey) {
    const pem = await readFile(SECRET_KEY_PATH, "utf8");
    // Testnet padrão usa ED25519. Troque para SECP256K1 se sua chave for dessa curva.
    agentKey = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  }
  return agentKey;
}

// Public key do agente em hex (endereço da carteira).
export async function getAgentPublicKeyHex(): Promise<string> {
  const key = await getAgentKey();
  return key.publicKey.toHex();
}
