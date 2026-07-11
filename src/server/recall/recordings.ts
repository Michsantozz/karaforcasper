import "server-only";

/**
 * Recording selection — a Recall bot's `recordings` field is an ARRAY. In the
 * common case it has one element, but a bot can produce more than one (re-join,
 * resumed recording), and the whole pipeline historically read `recordings[0]`
 * blindly — silently ignoring every recording but the first.
 *
 * This picks the recording we should read for minutes/media: prefer one whose
 * transcript is `done` (that's the one with data to work with); otherwise fall
 * back to the first. When there's more than one recording we log it, so the
 * multi-recording case stops being an invisible assumption.
 */

/** Minimal shape we need to choose a recording (structurally typed). */
interface RecordingLike {
  media_shortcuts?: {
    transcript?: { status?: { code?: string } } | null;
  } | null;
}

/**
 * Chooses the recording to read from a bot's `recordings` array. Prefers a
 * transcript-`done` recording, else the first. Returns undefined if empty.
 * `botId` is only used for the multi-recording log line.
 */
export function pickRecording<T extends RecordingLike>(
  recordings: T[] | undefined | null,
  botId?: string,
): T | undefined {
  if (!recordings?.length) return undefined;
  if (recordings.length > 1) {
    const withDone = recordings.filter(
      (r) => r.media_shortcuts?.transcript?.status?.code === "done",
    ).length;
    console.warn(
      `[recordings] bot ${botId ?? "?"} has ${recordings.length} recordings ` +
        `(${withDone} with a done transcript); reading the transcript-ready one.`,
    );
  }
  const ready = recordings.find(
    (r) => r.media_shortcuts?.transcript?.status?.code === "done",
  );
  return ready ?? recordings[0];
}
