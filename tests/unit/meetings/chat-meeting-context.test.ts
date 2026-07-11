import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * POST /api/chat — meeting-context injection. The notebook sends meetingBotId so
 * the agent knows which meeting is open. Security contract:
 *  - context is injected (system message prepended) ONLY if the caller OWNS the
 *    bot — a forged/unowned meetingBotId is silently dropped, never reaching the
 *    agent (can't point it at another tenant's meeting);
 *  - no session → 401, no agent call;
 *  - no meetingBotId → messages pass through untouched.
 *
 * handleChatStream/isBotOwner/session are mocked; we assert the messages handed
 * to the stream handler.
 */

const getSession = vi.fn();
const isBotOwner = vi.fn();
const handleChatStream = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/ownership", () => ({
  isBotOwner: (...a: unknown[]) => isBotOwner(...a),
}));
vi.mock("@mastra/ai-sdk", () => ({
  handleChatStream: (...a: unknown[]) => handleChatStream(...a),
}));
vi.mock("ai", () => ({
  createUIMessageStreamResponse: () => new Response("ok"),
  jsonSchema: (s: unknown) => s,
  tool: (t: unknown) => t,
}));
// The agent barrel is dynamically imported inside POST — stub it away.
vi.mock("@/mastra", () => ({ mastra: {} }));

type ParamsMessages = { messages?: Array<{ role: string }> };
function messagesPassedToHandler(): Array<{ role: string }> | undefined {
  const call = handleChatStream.mock.calls[0]?.[0] as {
    params: ParamsMessages;
  };
  return call?.params?.messages;
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request("http://x/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

const userMsg = { role: "user", parts: [{ type: "text", text: "summarize this" }] };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
  handleChatStream.mockResolvedValue({});
});

describe("POST /api/chat — meeting context", () => {
  it("owner: prepends a system message pinning the botId", async () => {
    isBotOwner.mockResolvedValue(true);
    await post({ meetingBotId: "bot-1", messages: [userMsg] });

    expect(isBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    const msgs = messagesPassedToHandler();
    expect(msgs?.[0].role).toBe("system");
    expect(JSON.stringify(msgs?.[0])).toContain("bot-1");
    // Original user message preserved after the injected context.
    expect(msgs?.[1]).toMatchObject({ role: "user" });
  });

  it("non-owner: drops meetingBotId, no system message injected", async () => {
    isBotOwner.mockResolvedValue(false);
    await post({ meetingBotId: "someone-elses", messages: [userMsg] });

    const msgs = messagesPassedToHandler();
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0].role).toBe("user");
  });

  it("no meetingBotId: messages pass through, ownership not checked", async () => {
    await post({ messages: [userMsg] });

    expect(isBotOwner).not.toHaveBeenCalled();
    const msgs = messagesPassedToHandler();
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0].role).toBe("user");
  });

  it("no session → 401, agent never called", async () => {
    getSession.mockResolvedValue(null);
    const res = await post({ meetingBotId: "bot-1", messages: [userMsg] });

    expect(res.status).toBe(401);
    expect(handleChatStream).not.toHaveBeenCalled();
  });
});
