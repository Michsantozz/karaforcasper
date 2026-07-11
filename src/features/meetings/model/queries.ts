"use client";

/**
 * TanStack Query layer for the meeting detail (player + karaoke).
 *
 * The GET /api/meetings/:botId backend returns the persisted minutes + the
 * transcript with timestamps + the video URL. The transcript/video may be
 * "processing" right after the meeting, so we do light polling until ready.
 */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

/**
 * Row status in the meetings index. "scheduled" is a synthetic status for
 * upcoming bots (joinAt in the future) that haven't recorded yet — it doesn't
 * exist in the DB enum; the rest mirror meeting_record_status.
 */
export type MeetingStatus =
  | "scheduled"
  | "pending"
  | "processing"
  | "done"
  | "failed";

/** One row in the meetings index. */
export interface MeetingListItem {
  botId: string;
  status: MeetingStatus;
  meetingUrl: string | null;
  summary: string | null;
  participantCount: number;
  /** ISO join time for scheduled rows; null for recorded ones. */
  joinAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MeetingsListResponse {
  meetings: MeetingListItem[];
  nextCursor: string | null;
}

/** Filters the meetings library query accepts (all optional). */
export interface MeetingsQuery {
  /** Keyword searched server-side over summary/overview/transcript. */
  q?: string;
  /** Filter to a single record status. */
  status?: Exclude<MeetingStatus, "scheduled">;
}

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
export interface MeetingSoundbite {
  label: string;
  startSeconds: number;
  endSeconds: number;
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
  soundbites: MeetingSoundbite[];
  talkShares: MeetingTalkShare[];
  videoUrl: string | null;
  transcript: TranscriptUtterance[];
  transcriptState: "ready" | "processing" | "none";
  createdAt: string;
}

/** HTTP error that carries the status so the UI can branch (404 vs 401 vs 5xx). */
export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`GET ${url} → ${status}`);
    this.name = "HttpError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json() as Promise<T>;
}

/** Builds the /api/meetings querystring from filters + cursor. */
function meetingsUrl(filters: MeetingsQuery, cursor: string | null): string {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.status) p.set("status", filters.status);
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  return qs ? `/api/meetings?${qs}` : "/api/meetings";
}

/**
 * Meetings index (paginated library). Server-side search + status filter +
 * keyset pagination (fetchNextPage follows nextCursor). Polls every 20s while a
 * loaded row is still pending/processing/scheduled, so a meeting that just
 * ended surfaces its minutes without a manual refresh.
 *
 * `flat` is the concatenation of all loaded pages — what the list renders.
 */
export function useMeetingsList(filters: MeetingsQuery = {}) {
  const query = useInfiniteQuery({
    queryKey: ["meetings", filters] as const,
    queryFn: ({ pageParam }) =>
      getJson<MeetingsListResponse>(meetingsUrl(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (q) =>
      q.state.data?.pages.some((pg) =>
        pg.meetings.some(
          (m) =>
            m.status === "pending" ||
            m.status === "processing" ||
            m.status === "scheduled",
        ),
      )
        ? 20_000
        : false,
  });

  const flat = query.data?.pages.flatMap((pg) => pg.meetings) ?? [];
  return { ...query, flat };
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
    // Don't retry client errors (404 not found / 401 unauthenticated) — they
    // won't fix themselves; only retry transient/5xx failures.
    retry: (count, err) => {
      const status = err instanceof HttpError ? err.status : 0;
      if (status === 404 || status === 401) return false;
      return count < 2;
    },
    refetchInterval: (query) =>
      query.state.data?.transcriptState === "processing" ? 15_000 : false,
  });
}
