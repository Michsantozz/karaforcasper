"use client";

/**
 * Camada TanStack Query do detalhe de reunião (player + karaoke).
 *
 * O backend GET /api/meetings/:botId retorna a ata persistida + a transcrição
 * com timestamps + a URL do vídeo. A transcrição/vídeo podem estar "processing"
 * logo após a reunião, então fazemos polling leve enquanto não fica pronto.
 */

import { useQuery } from "@tanstack/react-query";

export interface TranscriptWord {
  text: string;
  start: number | null;
  end: number | null;
}
export interface TranscriptUtterance {
  speaker: string;
  start: number | null;
  words: TranscriptWord[];
}
export interface MeetingActionItem {
  task: string;
  owner: string | null;
}
export interface MeetingSection {
  title: string;
  bullets: string[];
  startSeconds: number | null;
}
export interface MeetingMoment {
  label: string;
  kind: "topic" | "action" | "question" | "objection";
  atSeconds: number | null;
}
export interface MeetingTalkShare {
  name: string;
  share: number;
}

export interface MeetingDetailResponse {
  botId: string;
  status: string;
  meetingUrl: string | null;
  summary: string | null;
  overview: string | null;
  decisions: string[];
  actionItems: MeetingActionItem[];
  topics: string[];
  sections: MeetingSection[];
  moments: MeetingMoment[];
  talkShares: MeetingTalkShare[];
  videoUrl: string | null;
  transcript: TranscriptUtterance[];
  transcriptState: "ready" | "processing" | "none";
  createdAt: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Detalhe de uma reunião pelo botId. Enquanto a transcrição estiver "processing",
 * faz polling a cada 15s para o player/karaoke aparecerem assim que ficarem prontos.
 */
export function useMeetingDetail(botId: string) {
  return useQuery({
    queryKey: ["meeting", botId] as const,
    queryFn: () => getJson<MeetingDetailResponse>(`/api/meetings/${botId}`),
    enabled: Boolean(botId),
    refetchInterval: (query) =>
      query.state.data?.transcriptState === "processing" ? 15_000 : false,
  });
}
