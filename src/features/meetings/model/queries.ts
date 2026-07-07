"use client";

/**
 * TanStack Query layer for the meeting detail (player + karaoke).
 *
 * The GET /api/meetings/:botId backend returns the persisted minutes + the
 * transcript with timestamps + the video URL. The transcript/video may be
 * "processing" right after the meeting, so we do light polling until ready.
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
 * Meeting detail by botId. While the transcript is "processing", polls every
 * 15s so the player/karaoke appear as soon as they're ready.
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
