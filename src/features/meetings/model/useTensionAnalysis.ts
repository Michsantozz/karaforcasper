"use client";

/**
 * Client-side TENSION analysis for the notebook. Wraps shared/lib/prosody: on
 * demand, it decodes the meeting audio (mediabunny/WebCodecs), builds the energy
 * envelope, and scores each timing moment — telling apart real tension (a loud,
 * agitated overlap) from a casual backchannel (a quiet, flat one).
 *
 * On demand, not automatic: decoding audio is heavy, so it runs only when the
 * user clicks "analyze tension". One run at a time; the result is a lookup from
 * rounded second → tense/intensity that the UI overlays onto the moments.
 */

import { useCallback, useRef, useState } from "react";
import { analyzeProsody, scoreTension } from "@/shared/lib/prosody";

export interface TensionResult {
  /** rounded-second → { intensity 0..1, isTense }. */
  byAt: Map<number, { intensity: number; isTense: boolean }>;
}

export type TensionState =
  | { status: "idle" }
  | { status: "analyzing"; progress: number }
  | { status: "done"; result: TensionResult }
  | { status: "error"; message: string };

export function useTensionAnalysis() {
  const [state, setState] = useState<TensionState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (videoUrl: string, moments: Array<{ atSeconds: number }>) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ status: "analyzing", progress: 0 });
      try {
        const windows = await analyzeProsody({
          url: videoUrl,
          signal: controller.signal,
          onProgress: (progress) =>
            setState((s) =>
              s.status === "analyzing" ? { ...s, progress } : s,
            ),
        });
        const scores = scoreTension(windows, moments);
        const byAt = new Map(
          scores.map((s) => [
            Math.round(s.atSeconds),
            { intensity: s.intensity, isTense: s.isTense },
          ]),
        );
        setState({ status: "done", result: { byAt } });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setState({ status: "idle" });
          return;
        }
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Analysis failed",
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  return { state, run };
}
