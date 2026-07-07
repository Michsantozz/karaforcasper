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

// Testnet config. Everything comes from env (see .env.example).
export const CHAIN_NAME = process.env.CASPER_CHAIN_NAME ?? "casper-test";
const NODE_URL =
  process.env.CASPER_NODE_URL ?? "https://node.testnet.casper.network/rpc";
// Fallback outside the repo (~/.casper/keys) — the private key never lives at
// the project root (official SDK convention: dedicated folder). Override via env.
const SECRET_KEY_PATH =
  process.env.CASPER_AGENT_SECRET_KEY_PATH ??
  join(homedir(), ".casper", "keys", "agent-secret.pem");

// Single RpcClient reused across requests (HttpHandler with fetch).
let rpcClient: RpcClient | null = null;
export function getRpc(): RpcClient {
  if (!rpcClient) {
    rpcClient = new RpcClient(new HttpHandler(NODE_URL, "fetch"));
  }
  return rpcClient;
}

// Resolves the agent key PEM. Precedence:
//   1. CASPER_AGENT_SECRET_KEY_PEM  — PEM content directly in env (container
//      secret mount: Docker/K8s secret injects the env var, no file on disk).
//      Accepts raw PEM or base64-encoded PEM (\n in env is fragile; base64 is
//      the robust way).
//   2. CASPER_AGENT_SECRET_KEY_PATH — .pem file on disk (local dev, ~/.casper/keys).
// Fail-closed: if neither resolves, error explicitly instead of signing with the wrong key.
async function readAgentPem(): Promise<string> {
  const inline = process.env.CASPER_AGENT_SECRET_KEY_PEM?.trim();
  if (inline) {
    // A valid PEM starts with "-----BEGIN"; otherwise treat it as base64 and decode.
    return inline.startsWith("-----BEGIN")
      ? inline
      : Buffer.from(inline, "base64").toString("utf8");
  }
  return readFile(SECRET_KEY_PATH, "utf8");
}

// Agent private key, loaded from the .pem once.
let agentKey: PrivateKey | null = null;
export async function getAgentKey(): Promise<PrivateKey> {
  if (!agentKey) {
    const pem = await readAgentPem();
    // Key curve: SECP256K1 (Casper Wallet exports EC PRIVATE KEY).
    // Override via env CASPER_KEY_ALGORITHM=ED25519 if using an ed25519 key.
    const algo =
      process.env.CASPER_KEY_ALGORITHM === "ED25519"
        ? KeyAlgorithm.ED25519
        : KeyAlgorithm.SECP256K1;
    agentKey = PrivateKey.fromPem(pem, algo);
  }
  return agentKey;
}

// Agent's public key in hex (wallet address).
export async function getAgentPublicKeyHex(): Promise<string> {
  const key = await getAgentKey();
  return key.publicKey.toHex();
}
