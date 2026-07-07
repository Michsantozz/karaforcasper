import "server-only";
import { recallFetch } from "@/server/recall/client";
import { findMeetingRecord } from "@/server/recall/meeting-repository";
import type { MeetingRecordRow } from "@/shared/db/schema";

/**
 * Meeting detail for the UI (player + karaoke).
 *
 * Joins:
 *  - the persisted MINUTES (meeting_records) — summary, sections, moments, talk-shares;
 *  - the structured TRANSCRIPT with per-word timestamps — fetched on-demand from
 *    Recall (the one persisted in meeting_records is plain text, no timestamps,
 *    and karaoke needs the times to sync with the playhead);
 *  - the mixed VIDEO URL (signed, expires) — for the player.
 *
 * The caller must run within an RLS scope (meeting_records is tenant-scoped).
 */

/** Word with the time (seconds) it's spoken at — basis for the karaoke highlight. */
export interface TranscriptWordView {
  text: string;
  start: number | null;
  end: number | null;
}

/** Contiguous speech from a participant. */
export interface TranscriptUtteranceView {
  speaker: string;
  start: number | null;
  words: TranscriptWordView[];
}

export interface MeetingDetail {
  botId: string;
  record: MeetingRecordRow | null;
  transcript: TranscriptUtteranceView[];
  videoUrl: string | null;
  transcriptState: "ready" | "processing" | "none";
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

/** Builds the full detail of a meeting by botId. */
export async function getMeetingDetail(botId: string): Promise<MeetingDetail> {
  const record = await findMeetingRecord(botId);

  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  }).catch(() => null);

  const shortcuts = bot?.recordings?.[0]?.media_shortcuts;

  // Video: only if ready (signed URL, expires in hours).
  const video = shortcuts?.video_mixed;
  const videoUrl =
    video?.status?.code === "done" ? (video.data?.download_url ?? null) : null;

  // Structured transcript with timestamps.
  const transcriptArtifact = shortcuts?.transcript;
  let transcript: TranscriptUtteranceView[] = [];
  let transcriptState: "ready" | "processing" | "none" = "none";

  if (transcriptArtifact) {
    const url = transcriptArtifact.data?.download_url;
    if (transcriptArtifact.status?.code === "done" && url) {
      transcriptState = "ready";
      const segments = (await fetch(url)
        .then((r) => r.json())
        .catch(() => [])) as RawSegment[];
      transcript = segments.map(toUtterance);
    } else {
      transcriptState = "processing";
    }
  }

  return { botId, record, transcript, videoUrl, transcriptState };
}

function toUtterance(seg: RawSegment): TranscriptUtteranceView {
  const words: TranscriptWordView[] = (seg.words ?? []).map((w) => ({
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
