import "server-only";
import { recallFetch } from "@/server/recall/client";
import { findMeetingRecord } from "@/server/recall/meeting-repository";
import type { MeetingRecordRow } from "@/shared/db/schema";

/**
 * Detalhe de reunião para a UI (player + karaoke).
 *
 * Junta:
 *  - a ATA persistida (meeting_records) — resumo, seções, momentos, talk-shares;
 *  - a TRANSCRIÇÃO estruturada com timestamps por palavra — buscada on-demand do
 *    Recall (a persistida em meeting_records é texto plano, sem timestamps, e o
 *    karaoke precisa dos tempos para sincronizar com o playhead);
 *  - a URL do VÍDEO mixado (assinada, expira) — para o player.
 *
 * O caller deve rodar dentro de um escopo RLS (o meeting_records é tenant).
 */

/** Palavra com o tempo (segundos) em que é falada — base do highlight karaoke. */
export interface TranscriptWordView {
  text: string;
  start: number | null;
  end: number | null;
}

/** Fala contígua de um participante. */
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

/** Monta o detalhe completo de uma reunião pelo botId. */
export async function getMeetingDetail(botId: string): Promise<MeetingDetail> {
  const record = await findMeetingRecord(botId);

  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  }).catch(() => null);

  const shortcuts = bot?.recordings?.[0]?.media_shortcuts;

  // Vídeo: só se pronto (URL assinada, expira em horas).
  const video = shortcuts?.video_mixed;
  const videoUrl =
    video?.status?.code === "done" ? (video.data?.download_url ?? null) : null;

  // Transcrição estruturada com timestamps.
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
    speaker: seg.participant?.name ?? "Desconhecido",
    start: words.find((w) => w.start != null)?.start ?? null,
    words,
  };
}
