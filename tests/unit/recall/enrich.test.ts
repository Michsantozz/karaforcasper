import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * enrichMeeting — o worker durável de geração de atas, coração do fluxo
 * event-driven (disparado pelo workflow meeting-enrich) E da reconciliação
 * (cron). Testamos a máquina de estados: skip quando já pronto/sem record,
 * requeue quando o transcript não está pronto, fail quando vazio, done +
 * notificação no caminho feliz, e a política de retry (transiente vs. max).
 *
 * Todas as deps server-only (repo/summarize/media/notif/email/bot) são mockadas;
 * withSystemScope apenas executa a fn (sem RLS real).
 */

const findMeetingRecord = vi.fn();
const claimMeetingRecord = vi.fn();
const completeMeetingRecord = vi.fn();
const failMeetingRecord = vi.fn();
const requeueMeetingRecord = vi.fn();
const listStuckMeetingRecords = vi.fn();
const summarizeMeeting = vi.fn();
const captureMeetingMedia = vi.fn();
const findBotByBotId = vi.fn();
const botOwnerUserId = vi.fn();
const createNotification = vi.fn();
const emailMeetingSummaryReady = vi.fn();

vi.mock("@/server/recall/meeting-repository", () => ({
  findMeetingRecord: (...a: unknown[]) => findMeetingRecord(...a),
  claimMeetingRecord: (...a: unknown[]) => claimMeetingRecord(...a),
  completeMeetingRecord: (...a: unknown[]) => completeMeetingRecord(...a),
  failMeetingRecord: (...a: unknown[]) => failMeetingRecord(...a),
  requeueMeetingRecord: (...a: unknown[]) => requeueMeetingRecord(...a),
  listStuckMeetingRecords: (...a: unknown[]) => listStuckMeetingRecords(...a),
}));
vi.mock("@/server/recall/summarize", () => ({
  summarizeMeeting: (...a: unknown[]) => summarizeMeeting(...a),
}));
vi.mock("@/server/recall/media", () => ({
  captureMeetingMedia: (...a: unknown[]) => captureMeetingMedia(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByBotId: (...a: unknown[]) => findBotByBotId(...a),
  botOwnerUserId: (...a: unknown[]) => botOwnerUserId(...a),
}));
vi.mock("@/server/notifications", () => ({
  createNotification: (...a: unknown[]) => createNotification(...a),
}));
vi.mock("@/server/email", () => ({
  emailMeetingSummaryReady: (...a: unknown[]) => emailMeetingSummaryReady(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withSystemScope: (fn: () => unknown) => fn(),
}));

const CLAIMED = {
  userId: "owner-1",
  meetingUrl: "https://meet/x",
  attempts: 1,
};

async function importEnrich() {
  return import("@/server/recall/enrich");
}

beforeEach(() => {
  vi.resetModules();
  for (const m of [
    findMeetingRecord,
    claimMeetingRecord,
    completeMeetingRecord,
    failMeetingRecord,
    requeueMeetingRecord,
    listStuckMeetingRecords,
    summarizeMeeting,
    captureMeetingMedia,
    findBotByBotId,
    botOwnerUserId,
    createNotification,
    emailMeetingSummaryReady,
  ]) {
    m.mockReset();
  }
  captureMeetingMedia.mockResolvedValue({ transcriptStruct: null, videoUrl: null });
  createNotification.mockResolvedValue(undefined);
  emailMeetingSummaryReady.mockResolvedValue(undefined);
});

describe("enrichMeeting — máquina de estados", () => {
  it("skip quando a ata já está done (não reclama nem reprocessa)", async () => {
    findMeetingRecord.mockResolvedValue({ status: "done" });
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "skipped", reason: "already done" });
    expect(claimMeetingRecord).not.toHaveBeenCalled();
    expect(summarizeMeeting).not.toHaveBeenCalled();
  });

  it("skip quando não há record para reclamar (webhook ainda não enfileirou)", async () => {
    findMeetingRecord.mockResolvedValue(null);
    claimMeetingRecord.mockResolvedValue(null);
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "skipped", reason: "no pending record" });
    expect(summarizeMeeting).not.toHaveBeenCalled();
  });

  it("requeue quando o transcript ainda está processando (cron retenta)", async () => {
    findMeetingRecord.mockResolvedValue({ status: "pending" });
    claimMeetingRecord.mockResolvedValue(CLAIMED);
    summarizeMeeting.mockResolvedValue({ state: "processing" });
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "processing" });
    expect(requeueMeetingRecord).toHaveBeenCalledWith(
      "bot-1",
      "transcript still processing",
    );
    expect(completeMeetingRecord).not.toHaveBeenCalled();
  });

  it("fail quando o transcript vem vazio/indisponível", async () => {
    findMeetingRecord.mockResolvedValue({ status: "pending" });
    claimMeetingRecord.mockResolvedValue(CLAIMED);
    summarizeMeeting.mockResolvedValue({ state: "ready", summary: null });
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "failed", error: "empty transcript" });
    expect(failMeetingRecord).toHaveBeenCalledWith(
      "bot-1",
      "empty or unavailable transcript",
    );
  });

  it("done: persiste a ata, notifica o dono (in-app + email)", async () => {
    findMeetingRecord.mockResolvedValue({ status: "pending" });
    claimMeetingRecord.mockResolvedValue(CLAIMED);
    summarizeMeeting.mockResolvedValue({
      state: "ready",
      summary: "resumo",
      decisions: ["d1"],
      actionItems: ["t1", "t2"],
    });
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "done", notified: true });
    expect(completeMeetingRecord).toHaveBeenCalledWith(
      "bot-1",
      expect.objectContaining({ userId: "owner-1", summary: "resumo" }),
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        type: "meeting_summary_ready",
        link: "/meetings/bot-1",
      }),
    );
    expect(emailMeetingSummaryReady).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", botId: "bot-1" }),
    );
  });

  it("erro transiente antes do limite → requeue (state processing)", async () => {
    findMeetingRecord.mockResolvedValue({ status: "pending" });
    claimMeetingRecord.mockResolvedValue({ ...CLAIMED, attempts: 2 });
    summarizeMeeting.mockRejectedValue(new Error("LLM timeout"));
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "processing" });
    expect(requeueMeetingRecord).toHaveBeenCalledWith("bot-1", "LLM timeout");
    expect(failMeetingRecord).not.toHaveBeenCalled();
  });

  it("erro no limite de tentativas → fail permanente", async () => {
    findMeetingRecord.mockResolvedValue({ status: "pending" });
    claimMeetingRecord.mockResolvedValue({ ...CLAIMED, attempts: 5 });
    summarizeMeeting.mockRejectedValue(new Error("LLM down"));
    const { enrichMeeting } = await importEnrich();

    const res = await enrichMeeting("bot-1");

    expect(res).toEqual({ state: "failed", error: "LLM down" });
    expect(failMeetingRecord).toHaveBeenCalledWith(
      "bot-1",
      "max attempts: LLM down",
    );
    expect(requeueMeetingRecord).not.toHaveBeenCalled();
  });
});

describe("reconcileStuckMeetings — sweep", () => {
  it("processa cada bot preso e conta os desfechos", async () => {
    listStuckMeetingRecords.mockResolvedValue(["bot-a", "bot-b", "bot-c"]);
    // bot-a → done, bot-b → processing, bot-c → skipped (já done)
    findMeetingRecord
      .mockResolvedValueOnce({ status: "pending" }) // bot-a
      .mockResolvedValueOnce({ status: "pending" }) // bot-b
      .mockResolvedValueOnce({ status: "done" }); // bot-c → skip
    claimMeetingRecord
      .mockResolvedValueOnce(CLAIMED) // bot-a
      .mockResolvedValueOnce(CLAIMED); // bot-b
    summarizeMeeting
      .mockResolvedValueOnce({ state: "ready", summary: "ok" }) // bot-a done
      .mockResolvedValueOnce({ state: "processing" }); // bot-b requeue

    const { reconcileStuckMeetings } = await importEnrich();
    const res = await reconcileStuckMeetings(5 * 60_000);

    expect(listStuckMeetingRecords).toHaveBeenCalledWith(5 * 60_000);
    expect(res).toEqual({ processed: 3, done: 1, stillPending: 1 });
  });
});
