import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * MeetingDetail — notebook (player + karaoke + AI panels). Contrato:
 *  - loading/erro mostram seus estados;
 *  - renderiza os painéis de IA a partir dos dados (summary, moments, sections,
 *    decisions, action items, keywords, talk time);
 *  - clicar num momento/seção/palavra faz seek no <video> (currentTime + play);
 *  - o botão de clip só aparece quando há videoUrl; clicá-lo chama clip.run
 *    com o range da janela do momento.
 *
 * useMeetingDetail e useClip são mockados — isolamos a UI do notebook.
 */

let detail: {
  data?: unknown;
  isLoading?: boolean;
  error?: unknown;
  refetch?: () => void;
  isRefetching?: boolean;
};
const refetch = vi.fn();
vi.mock("@/features/meetings/model/queries", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useMeetingDetail: () => ({ refetch, isRefetching: false, ...detail }),
}));

const clipRun = vi.fn();
let clipState: { status: string; id?: string; progress?: number } = {
  status: "idle",
};
vi.mock("@/features/meetings/model/useClip", () => ({
  useClip: () => ({ state: clipState, run: clipRun, cancel: vi.fn() }),
}));

import { MeetingDetail } from "@/features/meetings/ui/MeetingDetail";
import { HttpError } from "@/features/meetings/model/queries";

function fullData(over: Record<string, unknown> = {}) {
  return {
    botId: "bot-1",
    status: "done",
    meetingUrl: "https://meet/x",
    // Título do header = 1ª frase; painel = summary completo. Duas frases para
    // que não colidam num único texto no DOM.
    summary: "Meeting title line. Full executive summary body here.",
    overview: "A narrative overview paragraph.",
    decisions: ["Ship the feature"],
    actionItems: [{ task: "Write tests", owner: "Marcus" }],
    topics: ["testing", "release"],
    sections: [
      { title: "Scope lock", bullets: ["Point A"], startSeconds: 0 },
    ],
    moments: [{ label: "Key decision", kind: "action", atSeconds: 30 }],
    soundbites: [
      { label: "Punchy quote", startSeconds: 40, endSeconds: 52 },
    ],
    talkShares: [
      { name: "Sarah", share: 0.6 },
      { name: "Diego", share: 0.4 },
    ],
    videoUrl: "http://x/v.mp4",
    transcript: [
      {
        speaker: "Sarah",
        start: 0,
        words: [
          { text: "Hello", start: 0, end: 1 },
          { text: "team", start: 1, end: 2 },
        ],
      },
    ],
    transcriptState: "ready",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  clipRun.mockReset();
  clipState = { status: "idle" };
  detail = { data: fullData(), isLoading: false, error: null };
  // jsdom: <video>.play() não existe — stub para o seek não lançar.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

describe("MeetingDetail — estados", () => {
  it("loading mostra 'loading minutes'", () => {
    detail = { data: undefined, isLoading: true };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/loading minutes/i)).toBeInTheDocument();
  });

  it("erro genérico mostra 'could not load' + botão de retry", async () => {
    detail = { data: undefined, isLoading: false, error: new Error("x") };
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("404 mostra 'not found' e NÃO oferece retry", () => {
    detail = {
      data: undefined,
      isLoading: false,
      error: new HttpError(404, "/api/meetings/x"),
    };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("401 mostra 'session expired' e NÃO oferece retry", () => {
    detail = {
      data: undefined,
      isLoading: false,
      error: new HttpError(401, "/api/meetings/x"),
    };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

describe("MeetingDetail — transcript search + a11y", () => {
  it("filtra o transcript pela busca e some quem não bate", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    // Antes: "Hello" e "team" visíveis.
    expect(screen.getByText("Hello")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/search transcript/i), "zzz");
    expect(screen.getByText(/no lines match/i)).toBeInTheDocument();
  });

  it("palavra do transcript é operável por teclado (Enter faz seek)", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    const video = document.querySelector("video") as HTMLVideoElement;

    const word = screen.getByText("team");
    expect(word).toHaveAttribute("role", "button");
    expect(word).toHaveAttribute("tabindex", "0");

    word.focus();
    await user.keyboard("{Enter}");
    expect(video.currentTime).toBe(1);
  });
});

describe("MeetingDetail — painéis de IA", () => {
  it("renderiza summary, decisions, action items, keywords e talk time", () => {
    render(<MeetingDetail botId="bot-1" />);
    expect(
      screen.getByText("Meeting title line. Full executive summary body here."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ship the feature")).toBeInTheDocument();
    expect(screen.getByText("Write tests")).toBeInTheDocument();
    expect(screen.getByText("Marcus")).toBeInTheDocument(); // owner chip
    expect(screen.getByText("testing")).toBeInTheDocument(); // keyword
    // "Sarah" aparece na legenda de speaker E no talk time — basta existir.
    expect(screen.getAllByText("Sarah").length).toBeGreaterThan(0);
    expect(screen.getByText("60%")).toBeInTheDocument(); // talk share (único)
  });

  it("mostra o momento e a seção com timestamps", () => {
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("Key decision")).toBeInTheDocument();
    expect(screen.getByText("Scope lock")).toBeInTheDocument();
    expect(screen.getByText("Point A")).toBeInTheDocument();
  });
});

describe("MeetingDetail — seek no vídeo", () => {
  it("clicar num momento move o currentTime e dá play", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    const video = document.querySelector("video") as HTMLVideoElement;

    await user.click(screen.getByRole("button", { name: /key decision/i }));

    expect(video.currentTime).toBe(30);
    expect(video.play).toHaveBeenCalled();
  });

  it("clicar numa palavra do transcript faz seek para o start dela", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    const video = document.querySelector("video") as HTMLVideoElement;

    await user.click(screen.getByText("team"));

    expect(video.currentTime).toBe(1);
  });
});

describe("MeetingDetail — botão de clip", () => {
  it("com videoUrl, o momento tem botão de clip que chama run com a janela", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    const clipBtn = screen.getByRole("button", { name: /clip this moment/i });
    await user.click(clipBtn);

    expect(clipRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "moment-0",
        videoUrl: "http://x/v.mp4",
        // janela ~16s: [at-4, at+12] = [26, 42]
        start: 26,
        end: 42,
      }),
    );
  });

  it("sem videoUrl, não há botão de clip", () => {
    detail = {
      data: fullData({ videoUrl: null }),
      isLoading: false,
    };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.queryByRole("button", { name: /clip this moment/i })).toBeNull();
  });
});

describe("MeetingDetail — soundbites curados", () => {
  it("renderiza o painel de soundbites com label e duração", () => {
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("Punchy quote")).toBeInTheDocument();
    // 40s · 12s (52-40).
    expect(screen.getByText(/0:40 · 12s/)).toBeInTheDocument();
  });

  it("clipar um soundbite usa o range EXATO (sem janela heurística)", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(
      screen.getByRole("button", { name: /clip this soundbite/i }),
    );

    expect(clipRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "soundbite-0",
        start: 40, // exato, não at-4
        end: 52, // exato, não at+12
      }),
    );
  });

  it("clipando um momento, o botão mostra o progresso em %", () => {
    clipState = { status: "clipping", id: "moment-0", progress: 0.5 };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("50")).toBeInTheDocument();
  });
});
