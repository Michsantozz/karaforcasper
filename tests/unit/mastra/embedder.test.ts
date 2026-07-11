import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * createEmbedder (mastra/model.ts) — the Fireworks embedder for Memory semantic
 * recall. Contract:
 *  - builds an @ai-sdk/openai provider pointed at Fireworks' OpenAI-compatible
 *    /embeddings endpoint (baseURL), authenticated with FIREWORKS_API_KEY;
 *  - defaults to qwen3-embedding-8b, overridable via FIREWORKS_EMBEDDING_MODEL_ID;
 *  - throws (requireEnv) when FIREWORKS_API_KEY is absent — this is WHY the agent
 *    builds memory lazily, so `next build` doesn't hit it env-free.
 *
 * We mock @ai-sdk/openai to capture the config/model without a network call.
 */

const createOpenAI = vi.fn();
const embedding = vi.fn((id: string) => ({ id }));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (cfg: unknown) => {
    createOpenAI(cfg);
    return { embedding: (id: string) => embedding(id) };
  },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIREWORKS_API_KEY = "fw-test-key";
  delete process.env.FIREWORKS_EMBEDDING_MODEL_ID;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createEmbedder", () => {
  it("points the provider at Fireworks with the API key", async () => {
    const { createEmbedder } = await import("@/mastra/model");
    createEmbedder();
    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw-test-key",
    });
  });

  it("defaults to qwen3-embedding-8b", async () => {
    const { createEmbedder } = await import("@/mastra/model");
    createEmbedder();
    expect(embedding).toHaveBeenCalledWith(
      "accounts/fireworks/models/qwen3-embedding-8b",
    );
  });

  it("honors FIREWORKS_EMBEDDING_MODEL_ID override", async () => {
    process.env.FIREWORKS_EMBEDDING_MODEL_ID = "accounts/fireworks/models/custom";
    const { createEmbedder } = await import("@/mastra/model");
    createEmbedder();
    expect(embedding).toHaveBeenCalledWith("accounts/fireworks/models/custom");
  });

  it("throws when FIREWORKS_API_KEY is missing (why memory is lazy)", async () => {
    delete process.env.FIREWORKS_API_KEY;
    const { createEmbedder } = await import("@/mastra/model");
    expect(() => createEmbedder()).toThrow(/FIREWORKS_API_KEY/);
  });
});
