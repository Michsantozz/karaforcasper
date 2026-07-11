import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * captureMeetingMedia — durable capture of a meeting's word-level transcript +
 * mixed video into our own storage, so the notebook survives Recall's artifact
 * expiry. Contract:
 *  - transcript "done" → downloaded + normalized to the UI utterance shape;
 *  - video "done" → downloaded from Recall and re-uploaded (permanent URL);
 *  - anything not ready / any failure → null for THAT piece, never throws
 *    (the text summary is the priority; media is best-effort).
 *
 * recallFetch, global fetch, and uploadObject are mocked.
 */

const recallFetch = vi.fn();
const uploadObject = vi.fn();

vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
}));
vi.mock("@/server/storage/s3", () => ({
  uploadObject: (...a: unknown[]) => uploadObject(...a),
}));

const originalFetch = globalThis.fetch;

function bot(shortcuts: Record<string, unknown>) {
  return { id: "bot-1", recordings: [{ media_shortcuts: shortcuts }] };
}
const readyArtifact = (url: string) => ({
  status: { code: "done" },
  data: { download_url: url },
});

async function load() {
  return import("@/server/recall/media");
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadObject.mockResolvedValue({ url: "https://cdn/meeting-bot-1.mp4" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("captureMeetingMedia — transcript", () => {
  it("normalizes a ready transcript to utterances with word timestamps", async () => {
    recallFetch.mockResolvedValue(
      bot({ transcript: readyArtifact("https://recall/t.json") }),
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          participant: { name: "Alice" },
          words: [
            { text: "hi", start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } },
          ],
        },
      ],
    }) as unknown as typeof fetch;

    const { captureMeetingMedia } = await load();
    const media = await captureMeetingMedia("bot-1", "u1");

    expect(media.transcriptStruct).toEqual([
      { speaker: "Alice", start: 1, words: [{ text: "hi", start: 1, end: 2 }] },
    ]);
  });

  it("transcript not ready → null (no download)", async () => {
    recallFetch.mockResolvedValue(
      bot({ transcript: { status: { code: "processing" } } }),
    );
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { captureMeetingMedia } = await load();
    const media = await captureMeetingMedia("bot-1", "u1");

    expect(media.transcriptStruct).toBeNull();
  });

  it("transcript download throwing → null (never throws)", async () => {
    recallFetch.mockResolvedValue(
      bot({ transcript: readyArtifact("https://recall/t.json") }),
    );
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as unknown as typeof fetch;

    const { captureMeetingMedia } = await load();
    const media = await captureMeetingMedia("bot-1", "u1");
    expect(media.transcriptStruct).toBeNull();
  });
});

describe("captureMeetingMedia — video", () => {
  it("downloads the video and re-uploads it, returning the durable URL", async () => {
    recallFetch.mockResolvedValue(
      bot({ video_mixed: readyArtifact("https://recall/v.mp4") }),
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }) as unknown as typeof fetch;

    const { captureMeetingMedia } = await load();
    const media = await captureMeetingMedia("bot-1", "u1");

    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        filename: "meeting-bot-1.mp4",
        contentType: "video/mp4",
      }),
    );
    expect(media.videoUrl).toBe("https://cdn/meeting-bot-1.mp4");
  });

  it("upload failing → null videoUrl (best-effort, never throws)", async () => {
    recallFetch.mockResolvedValue(
      bot({ video_mixed: readyArtifact("https://recall/v.mp4") }),
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }) as unknown as typeof fetch;
    uploadObject.mockRejectedValue(new Error("s3 down"));

    const { captureMeetingMedia } = await load();
    const media = await captureMeetingMedia("bot-1", "u1");
    expect(media.videoUrl).toBeNull();
  });

  it("anonymous bot (no userId) namespaces under _shared", async () => {
    recallFetch.mockResolvedValue(
      bot({ video_mixed: readyArtifact("https://recall/v.mp4") }),
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }) as unknown as typeof fetch;

    const { captureMeetingMedia } = await load();
    await captureMeetingMedia("bot-1", null);
    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "_shared" }),
    );
  });
});
