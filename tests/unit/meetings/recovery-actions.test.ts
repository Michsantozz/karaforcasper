import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Meetings recovery Server Actions — reprocessMeeting / cancelScheduledMeeting.
 * Security is the crux: both derive the userId from the SESSION and assert bot
 * ownership before doing anything. Contract:
 *  - no session → { ok:false, error:"unauthenticated" }, no work;
 *  - not owner → { ok:false, error:"not found or not accessible" }, no work;
 *  - reprocess (owner) → requeues under the user's scope + runs enrichMeeting;
 *  - cancel (owner) → DELETEs the bot on Recall + clears the dedup mapping.
 *
 * All server deps are mocked; we assert the ownership gate and the side effects.
 */

const requireUserId = vi.fn();
const assertBotOwner = vi.fn();
const requeueMeetingRecord = vi.fn();
const enableMeetingShare = vi.fn();
const disableMeetingShare = vi.fn();
const enrichMeeting = vi.fn();
const findBotByBotId = vi.fn();
const deleteBotMapping = vi.fn();
const recallFetch = vi.fn();
const withUserScope = vi.fn((_u: string, fn: () => unknown) => fn());

vi.mock("@/features/auth/model/session", () => ({
  requireUserId: (...a: unknown[]) => requireUserId(...a),
}));
vi.mock("@/server/recall/ownership", () => ({
  assertBotOwner: (...a: unknown[]) => assertBotOwner(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  requeueMeetingRecord: (...a: unknown[]) => requeueMeetingRecord(...a),
  enableMeetingShare: (...a: unknown[]) => enableMeetingShare(...a),
  disableMeetingShare: (...a: unknown[]) => disableMeetingShare(...a),
}));
vi.mock("@/server/recall/enrich", () => ({
  enrichMeeting: (...a: unknown[]) => enrichMeeting(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByBotId: (...a: unknown[]) => findBotByBotId(...a),
  deleteBotMapping: (...a: unknown[]) => deleteBotMapping(...a),
}));
vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (u: string, fn: () => unknown) => withUserScope(u, fn),
}));

async function load() {
  return import("@/features/meetings/api/actions");
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("u1");
  assertBotOwner.mockResolvedValue(undefined);
  enrichMeeting.mockResolvedValue({ state: "done" });
  findBotByBotId.mockResolvedValue({ dedupKey: "dk-1" });
  recallFetch.mockResolvedValue(undefined);
});

describe("reprocessMeeting", () => {
  it("owner → requeues under user scope and runs enrichMeeting", async () => {
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("bot-1");

    expect(res).toEqual({ ok: true });
    expect(assertBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(requeueMeetingRecord).toHaveBeenCalledWith("bot-1", "manual reprocess");
    expect(enrichMeeting).toHaveBeenCalledWith("bot-1");
  });

  it("not owner → refuses without requeue/enrich", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("someone-elses");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(requeueMeetingRecord).not.toHaveBeenCalled();
    expect(enrichMeeting).not.toHaveBeenCalled();
  });

  it("no session → unauthenticated, no work", async () => {
    requireUserId.mockRejectedValue(new Error("unauthenticated"));
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("bot-1");

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(assertBotOwner).not.toHaveBeenCalled();
    expect(requeueMeetingRecord).not.toHaveBeenCalled();
  });

  it("enrich still failed → surfaces the error", async () => {
    enrichMeeting.mockResolvedValue({ state: "failed", error: "empty transcript" });
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("bot-1");
    expect(res).toEqual({ ok: false, error: "empty transcript" });
  });
});

describe("cancelScheduledMeeting", () => {
  it("owner → DELETEs the bot on Recall and clears the mapping", async () => {
    const { cancelScheduledMeeting } = await load();
    const res = await cancelScheduledMeeting("bot-1");

    expect(res).toEqual({ ok: true });
    expect(recallFetch).toHaveBeenCalledWith({
      method: "DELETE",
      path: "v1/bot/bot-1/",
    });
    expect(deleteBotMapping).toHaveBeenCalledWith("dk-1");
  });

  it("not owner → refuses without calling Recall", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { cancelScheduledMeeting } = await load();
    const res = await cancelScheduledMeeting("someone-elses");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(recallFetch).not.toHaveBeenCalled();
    expect(deleteBotMapping).not.toHaveBeenCalled();
  });

  it("Recall DELETE fails → returns the error, no mapping delete", async () => {
    recallFetch.mockRejectedValue(new Error("recall 500"));
    const { cancelScheduledMeeting } = await load();
    const res = await cancelScheduledMeeting("bot-1");

    expect(res.ok).toBe(false);
    expect(deleteBotMapping).not.toHaveBeenCalled();
  });
});

describe("setMeetingShare — public share-link toggle", () => {
  it("unauthenticated → rejected, share never touched", async () => {
    requireUserId.mockRejectedValue(new Error("no session"));
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(enableMeetingShare).not.toHaveBeenCalled();
    expect(disableMeetingShare).not.toHaveBeenCalled();
  });

  it("non-owner → refused, share never enabled (no public leak)", async () => {
    assertBotOwner.mockRejectedValue(new Error("not accessible"));
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(enableMeetingShare).not.toHaveBeenCalled();
  });

  it("owner enable → mints a token under user scope", async () => {
    enableMeetingShare.mockResolvedValue({ shareToken: "tok-abc" });
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: true, shareToken: "tok-abc" });
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(enableMeetingShare).toHaveBeenCalledWith("bot-1");
  });

  it("owner disable → clears the token, returns null", async () => {
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", false);

    expect(res).toEqual({ ok: true, shareToken: null });
    expect(disableMeetingShare).toHaveBeenCalledWith("bot-1");
    expect(enableMeetingShare).not.toHaveBeenCalled();
  });

  it("enable but the meeting vanished → not-accessible, no token returned", async () => {
    enableMeetingShare.mockResolvedValue(null);
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
  });
});
