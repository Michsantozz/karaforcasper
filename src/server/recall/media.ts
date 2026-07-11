import "server-only";
import { Buffer } from "node:buffer";
import { recallFetch } from "@/server/recall/client";
import { pickRecording } from "@/server/recall/recordings";
import { uploadObject } from "@/server/storage/s3";

/**
 * Durable capture of a meeting's media, so the notebook survives Recall's
 * artifact expiry (Recall's transcript/video URLs are signed and expire in
 * hours-to-days). Called by the enrichment worker when minutes become "done":
 *  - the WORD-LEVEL transcript is downloaded and normalized to the UI shape,
 *    then persisted as jsonb in meeting_records.transcript_struct;
 *  - the mixed VIDEO is downloaded from Recall and re-uploaded to our own object
 *    storage (S3/MinIO), yielding a permanent URL.
 *
 * Best-effort: any failure here returns null for that piece and is logged — it
 * must never fail the whole enrichment (the text summary is the priority).
 */

/** UI-shaped utterance (mirrors TranscriptUtteranceView in meeting-detail). */
export interface StructuredUtterance {
  speaker: string;
  start: number | null;
  words: Array<{ text: string; start: number | null; end: number | null }>;
}

type RecallMediaArtifact = {
  status?: { code?: string };
  data?: { download_url?: string };
} | null;

type RecallBot = {
  id: string;
  recordings?: Array<{
    media_shortcuts?: {
      transcript?: RecallMediaArtifact;
      video_mixed?: RecallMediaArtifact;
    };
  }>;
};

type RawSegment = {
  participant?: { name?: string | null };
  words?: Array<{
    text?: string;
    start_timestamp?: { relative?: number } | null;
    end_timestamp?: { relative?: number } | null;
  }>;
};

export interface CapturedMedia {
  transcriptStruct: StructuredUtterance[] | null;
  videoUrl: string | null;
}

/** Normalizes a raw Recall segment to the persisted/UI utterance shape. */
function toUtterance(seg: RawSegment): StructuredUtterance {
  const words = (seg.words ?? []).map((w) => ({
    text: w.text ?? "",
    start: w.start_timestamp?.relative ?? null,
    end: w.end_timestamp?.relative ?? null,
  }));
  return {
    speaker: seg.participant?.name ?? "Unknown",
    start: words.find((w) => w.start != null)?.start ?? null,
    words,
  };
}

/**
 * Downloads a bot's word-level transcript + copies its mixed video to durable
 * storage. `userId` scopes the stored object key to the owner. Returns nulls for
 * pieces that aren't ready or that fail — never throws.
 */
export async function captureMeetingMedia(
  botId: string,
  userId: string | null,
): Promise<CapturedMedia> {
  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  }).catch(() => null);

  const shortcuts = pickRecording(bot?.recordings, botId)?.media_shortcuts;

  const transcriptStruct = await captureTranscript(shortcuts?.transcript);
  const videoUrl = await captureVideo(shortcuts?.video_mixed, botId, userId);

  return { transcriptStruct, videoUrl };
}

/** Downloads + normalizes the word-level transcript, or null if not ready. */
async function captureTranscript(
  artifact: RecallMediaArtifact | undefined,
): Promise<StructuredUtterance[] | null> {
  const url = artifact?.data?.download_url;
  if (artifact?.status?.code !== "done" || !url) return null;
  try {
    const segments = (await fetch(url).then((r) => r.json())) as RawSegment[];
    if (!Array.isArray(segments)) return null;
    return segments.map(toUtterance);
  } catch (err) {
    console.error(`[media] transcript capture failed for ${err}`);
    return null;
  }
}

/**
 * Downloads the mixed video from Recall and re-uploads it to our storage.
 * Returns the permanent URL, or null if not ready / storage unconfigured /
 * download fails. Storage errors are swallowed (the signed-URL fallback in
 * getMeetingDetail still works until Recall expires it).
 */
async function captureVideo(
  artifact: RecallMediaArtifact | undefined,
  botId: string,
  userId: string | null,
): Promise<string | null> {
  const url = artifact?.data?.download_url;
  if (artifact?.status?.code !== "done" || !url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const uploaded = await uploadObject({
      // Namespace by owner; anonymous bots (no userId) go under "_shared".
      userId: userId ?? "_shared",
      filename: `meeting-${botId}.mp4`,
      contentType: "video/mp4",
      body: bytes,
    });
    return uploaded.url;
  } catch (err) {
    console.error(`[media] video capture failed for ${botId}: ${err}`);
    return null;
  }
}
