import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

import { requireEnv } from "@/mastra/env";

// Bedrock DNS often returns a mix of public and CGNAT (100.64/10) addresses on
// WSL2/VPN setups; undici's Happy-Eyeballs can latch onto a blackholed IP and
// stall for the full 10s connect timeout (UND_ERR_CONNECT_TIMEOUT). Retrying
// re-runs DNS resolution, so a fresh attempt usually lands on a reachable IP.
const CONNECT_RETRIES = 3;

function isRetryableNetworkError(error: unknown) {
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

const resilientFetch: typeof fetch = async (input, init) => {
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
