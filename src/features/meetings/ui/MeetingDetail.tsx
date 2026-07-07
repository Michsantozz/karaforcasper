"use client";

/**
 * Surface de detalhe de reunião: player de vídeo + transcrição "karaoke" (a
 * palavra falada é destacada em sincronia com o playhead) + notas de IA (resumo,
 * seções, momentos, decisões, action items, talk-shares).
 *
 * Fireflies/Gong-style, sem dependências externas: player HTML5 nativo, sync via
 * evento `timeupdate`. Clicar numa palavra/seção/momento salta o vídeo (seek).
 */

import { useMemo, useRef, useState } from "react";
import {
  useMeetingDetail,
  type MeetingDetailResponse,
} from "@/features/meetings/model/queries";

export function MeetingDetail({ botId }: { botId: string }) {
  const { data, isLoading, error } = useMeetingDetail(botId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  function seek(seconds: number | null) {
    if (seconds == null || !videoRef.current) return;
    videoRef.current.currentTime = seconds;
    void videoRef.current.play();
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Carregando ata…</div>;
  }
  if (error || !data) {
    return (
      <div className="p-6 text-sm text-destructive">
        Não foi possível carregar esta reunião.
      </div>
    );
  }

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-[1fr_380px]">
      {/* Coluna principal: player + transcrição karaoke */}
      <div className="flex flex-col gap-4">
        <VideoPanel
          videoUrl={data.videoUrl}
          transcriptState={data.transcriptState}
          videoRef={videoRef}
          onTime={setCurrentTime}
        />
        <TranscriptPanel
          data={data}
          currentTime={currentTime}
          onSeek={seek}
        />
      </div>

      {/* Coluna lateral: notas de IA */}
      <NotesPanel data={data} onSeek={seek} />
    </div>
  );
}

function VideoPanel({
  videoUrl,
  transcriptState,
  videoRef,
  onTime,
}: {
  videoUrl: string | null;
  transcriptState: MeetingDetailResponse["transcriptState"];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTime: (t: number) => void;
}) {
  if (!videoUrl) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-lg border bg-muted/30 text-sm text-muted-foreground">
        {transcriptState === "processing"
          ? "Gravação ainda sendo processada…"
          : "Sem vídeo disponível para esta reunião."}
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      src={videoUrl}
      controls
      className="aspect-video w-full rounded-lg bg-black"
      onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
    />
  );
}

function TranscriptPanel({
  data,
  currentTime,
  onSeek,
}: {
  data: MeetingDetailResponse;
  currentTime: number;
  onSeek: (s: number | null) => void;
}) {
  if (data.transcript.length === 0) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        {data.transcriptState === "processing"
          ? "Transcrição em processamento — aparece aqui assim que ficar pronta."
          : "Sem transcrição para esta reunião."}
      </div>
    );
  }
  return (
    <div className="max-h-[420px] overflow-y-auto rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">Transcrição</h3>
      <div className="space-y-3 text-sm leading-relaxed">
        {data.transcript.map((utt, i) => (
          <p key={i}>
            <button
              type="button"
              onClick={() => onSeek(utt.start)}
              className="mr-1 font-medium text-primary hover:underline"
            >
              {utt.speaker}:
            </button>
            {utt.words.map((w, j) => {
              const active =
                w.start != null &&
                w.end != null &&
                currentTime >= w.start &&
                currentTime < w.end;
              return (
                <span
                  key={j}
                  onClick={() => onSeek(w.start)}
                  className={
                    active
                      ? "cursor-pointer rounded bg-primary/20 font-medium text-foreground"
                      : "cursor-pointer text-muted-foreground hover:text-foreground"
                  }
                >
                  {w.text}{" "}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </div>
  );
}

function NotesPanel({
  data,
  onSeek,
}: {
  data: MeetingDetailResponse;
  onSeek: (s: number | null) => void;
}) {
  const sortedShares = useMemo(
    () => [...data.talkShares].sort((a, b) => b.share - a.share),
    [data.talkShares],
  );

  return (
    <div className="flex max-h-[860px] flex-col gap-5 overflow-y-auto rounded-lg border p-4">
      {data.summary && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Resumo</h3>
          <p className="text-sm text-muted-foreground">{data.summary}</p>
        </section>
      )}

      {data.overview && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Visão geral</h3>
          <p className="text-sm text-muted-foreground">{data.overview}</p>
        </section>
      )}

      {data.moments.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Momentos-chave</h3>
          <ul className="space-y-1">
            {data.moments.map((m, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className={`rounded px-1.5 py-0.5 text-xs ${momentColor(m.kind)}`}>
                  {momentLabel(m.kind)}
                </span>
                <button
                  type="button"
                  onClick={() => onSeek(m.atSeconds)}
                  className="text-left text-muted-foreground hover:text-foreground hover:underline"
                >
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.sections.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Seções</h3>
          <div className="space-y-3">
            {data.sections.map((s, i) => (
              <div key={i}>
                <button
                  type="button"
                  onClick={() => onSeek(s.startSeconds)}
                  className="text-sm font-medium hover:underline"
                >
                  {s.title}
                </button>
                <ul className="ml-4 list-disc text-sm text-muted-foreground">
                  {s.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.decisions.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Decisões</h3>
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
            {data.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      )}

      {data.actionItems.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Action items</h3>
          <ul className="space-y-1 text-sm">
            {data.actionItems.map((a, i) => (
              <li key={i} className="text-muted-foreground">
                {a.task}
                {a.owner && (
                  <span className="ml-1 text-xs text-primary">@{a.owner}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {sortedShares.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Tempo de fala</h3>
          <div className="space-y-2">
            {sortedShares.map((p, i) => (
              <div key={i}>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{p.name}</span>
                  <span>{Math.round(p.share * 100)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted">
                  <div
                    className="h-1.5 rounded-full bg-primary"
                    style={{ width: `${Math.round(p.share * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function momentLabel(kind: MeetingDetailResponse["moments"][number]["kind"]) {
  return { topic: "Tópico", action: "Ação", question: "Pergunta", objection: "Objeção" }[
    kind
  ];
}
function momentColor(kind: MeetingDetailResponse["moments"][number]["kind"]) {
  return {
    topic: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    action: "bg-green-500/15 text-green-600 dark:text-green-400",
    question: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    objection: "bg-red-500/15 text-red-600 dark:text-red-400",
  }[kind];
}
