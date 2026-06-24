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
