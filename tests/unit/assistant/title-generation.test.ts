import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `generateThreadTitle` — the one-shot LLM title generator behind the
 * ThreadList's `generateTitle`. It pulls the thread's opening turns, asks the
 * chat model for a ≤5-word title, normalizes the output, and persists it via
 * the Memory-backed `updateThread`. We mock the model (`generateText`) and the
 * Mastra Memory so this is a pure-logic test: transcript building, output
 * normalization, and the empty-thread guard.
 */

const generateText = vi.fn();

// Memory surface used by the thread store (recall → getThreadById → updateThread).
const recall = vi.fn();
const getThreadById = vi.fn();
const updateThread = vi.fn();
const getMemory = vi.fn(() => ({ recall, getThreadById, updateThread }));

vi.mock("ai", () => ({
  generateText: (...a: unknown[]) => generateText(...a),
}));
vi.mock("@/mastra/model", () => ({ createChatModel: () => ({}) }));
// The store resolves Memory via `agent.getMemory()`; mock the agent graph.
vi.mock("@/mastra", () => ({
  mastra: { getAgentById: () => ({ getMemory: () => getMemory() }) },
}));
// Identity converter: return the recalled messages unchanged so the test drives
// the exact `parts` shapes it wants to assert on.
vi.mock("@mastra/ai-sdk/ui", () => ({
  toAISdkMessages: (messages: unknown) => messages,
}));

// Imported after the mocks are registered.
const { generateThreadTitle } = await import(
  "@/features/assistant/model/threads"
);

const textMsg = (role: string, text: string) => ({
  id: `${role}-1`,
  role,
  parts: [{ type: "text", text }],
});

beforeEach(() => {
  vi.clearAllMocks();
  // updateThread reads the existing thread first (ownership + metadata merge).
  getThreadById.mockResolvedValue({
    id: "t1",
    resourceId: "u1",
    title: "New Chat",
    metadata: {},
  });
  updateThread.mockResolvedValue(undefined);
});

describe("generateThreadTitle", () => {
  it("returns null and skips the model for an empty thread", async () => {
    recall.mockResolvedValue({ messages: [] });
    const title = await generateThreadTitle("u1", "t1");
    expect(title).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
    expect(updateThread).not.toHaveBeenCalled();
  });

  it("returns null when the only messages have no text parts", async () => {
    recall.mockResolvedValue({
      messages: [{ id: "a", role: "assistant", parts: [{ type: "tool-call" }] }],
    });
    const title = await generateThreadTitle("u1", "t1");
    expect(title).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("generates, normalizes, and persists the title", async () => {
    recall.mockResolvedValue({
      messages: [
        textMsg("user", "Can you summarize yesterday's standup?"),
        textMsg("assistant", "Sure — here are the highlights."),
      ],
    });
    generateText.mockResolvedValue({ text: "Standup Summary" });

    const title = await generateThreadTitle("u1", "t1");

    expect(title).toBe("Standup Summary");
    // Persisted through the store's rename path (updateThread under the hood).
    expect(updateThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", title: "Standup Summary" }),
    );
    // Prompt carries the transcript so the model can name the topic.
    const prompt = generateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("user: Can you summarize yesterday's standup?");
    expect(prompt).toContain("assistant: Sure — here are the highlights.");
  });

  it("strips wrapping quotes and a trailing period", async () => {
    recall.mockResolvedValue({ messages: [textMsg("user", "hi there")] });
    generateText.mockResolvedValue({ text: '"Friendly Greeting."' });
    expect(await generateThreadTitle("u1", "t1")).toBe("Friendly Greeting");
  });

  it("collapses whitespace and caps length at 80 chars", async () => {
    recall.mockResolvedValue({ messages: [textMsg("user", "long one")] });
    generateText.mockResolvedValue({
      text: `  Lots   of    spaces   ${"x".repeat(120)}  `,
    });
    const title = await generateThreadTitle("u1", "t1");
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain("   "); // no runs of whitespace
  });

  it("returns null when the model yields an empty title (no rename)", async () => {
    recall.mockResolvedValue({ messages: [textMsg("user", "hi")] });
    generateText.mockResolvedValue({ text: "   " });
    expect(await generateThreadTitle("u1", "t1")).toBeNull();
    expect(updateThread).not.toHaveBeenCalled();
  });
});
