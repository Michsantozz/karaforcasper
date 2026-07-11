import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";

import { requireEnv } from "@/shared/lib/env";

// Bedrock DNS often returns a mix of public and CGNAT (100.64/10) addresses on
// WSL2/VPN setups; undici's Happy-Eyeballs can latch onto a blackholed IP and
// stall for the full 10s connect timeout (UND_ERR_CONNECT_TIMEOUT). Retrying
// re-runs DNS resolution, so a fresh attempt usually lands on a reachable IP.
const CONNECT_RETRIES = 3;

export function isRetryableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code =
    (error as { code?: string }).code ??
    ((error as { cause?: { code?: string } }).cause?.code ?? "");
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    // undici surfaces connect failures as a bare TypeError ("fetch failed")
    error.name === "TypeError"
  );
}

export const resilientFetch: typeof fetch = async (input, init) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new Error("Request aborted.");
    }
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      const aborted = init?.signal?.aborted === true;
      if (
        aborted ||
        attempt === CONNECT_RETRIES ||
        !isRetryableNetworkError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
};

export function createBedrockModel() {
  const bedrock = createAmazonBedrock({
    region: requireEnv("BEDROCK_REGION"),
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    ...(process.env.AWS_SESSION_TOKEN
      ? { sessionToken: process.env.AWS_SESSION_TOKEN }
      : {}),
    fetch: resilientFetch,
  });

  return bedrock(requireEnv("BEDROCK_MODEL_ID"));
}

// Fireworks AI (AMD Hackathon Track 3 — inference runs on AMD hardware).
// `fireworks-ai` is a Mastra-registered provider, so we pass the MAGIC STRING
// (`fireworks-ai/<model>`) and let Mastra resolve the endpoint + read the key
// from FIREWORKS_API_KEY (the provider's apiKeyEnvVar). Passing an explicit
// {url,apiKey} object instead made Mastra treat it as a custom provider and the
// request silently produced an empty response (no auth applied). requireEnv
// still asserts the key is present at request time (fail fast, not fail silent).
const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/models/glm-5p2";

export function createFireworksModel() {
  const id = process.env.FIREWORKS_MODEL_ID ?? DEFAULT_FIREWORKS_MODEL;
  return {
    url: "https://api.fireworks.ai/inference/v1/",
    id: `fireworks-ai/${id}` as `${string}/${string}`,
    apiKey: requireEnv("FIREWORKS_API_KEY"),
  };
}

// Provider dispatcher — MODEL_PROVIDER selects the backend at request time.
// Defaults to Fireworks (the hackathon target); Bedrock stays as a fallback so
// existing flows keep working if FIREWORKS_API_KEY is absent.
export function createModel() {
  const provider = (process.env.MODEL_PROVIDER ?? "fireworks").toLowerCase();
  if (provider === "bedrock") return createBedrockModel();
  return createFireworksModel();
}

// ai-sdk LanguageModel for structured generation (generateObject/generateText).
// Unlike createFireworksModel() — which returns Mastra's router CONFIG object —
// this returns a real ai-sdk model via the OpenAI provider pointed at Fireworks'
// OpenAI-compatible endpoint, so it plugs straight into `generateObject`. Used
// by server-side one-shot LLM calls (e.g. the meeting-health insight) that don't
// go through the Mastra agent runtime. Honors MODEL_PROVIDER=bedrock as fallback.
export function createChatModel() {
  const provider = (process.env.MODEL_PROVIDER ?? "fireworks").toLowerCase();
  if (provider === "bedrock") return createBedrockModel();
  const fireworks = createOpenAI({
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKey: requireEnv("FIREWORKS_API_KEY"),
  });
  return fireworks.chat(
    process.env.FIREWORKS_MODEL_ID ?? DEFAULT_FIREWORKS_MODEL,
  );
}

// Embedder for Memory semantic recall — runs on Fireworks' OpenAI-compatible
// /embeddings endpoint via the @ai-sdk/openai provider (baseURL override), so we
// reuse the same FIREWORKS_API_KEY. Qwen3-Embedding-8B outputs 4096-dim vectors
// (measured against the live endpoint); PgVector auto-creates its index at that
// dimension on first upsert. $0.10/M tokens — one embed per stored message and
// one per recall query. Lazy for the same reason as the chat model.
const DEFAULT_EMBEDDING_MODEL = "accounts/fireworks/models/qwen3-embedding-8b";

export function createEmbedder() {
  const fireworks = createOpenAI({
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKey: requireEnv("FIREWORKS_API_KEY"),
  });
  return fireworks.embedding(
    process.env.FIREWORKS_EMBEDDING_MODEL_ID ?? DEFAULT_EMBEDDING_MODEL,
  );
}
