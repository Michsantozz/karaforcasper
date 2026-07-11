import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render as rtlRender,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeQueryWrapper } from "../helpers/query-wrapper";

// RowAction uses useMutation/useQueryClient, so the list needs a QueryClient in
// context. Render through a fresh wrapper per test (no cross-test cache bleed).
function render(ui: React.ReactElement) {
  const { wrapper: Wrapper, queryClient } = makeQueryWrapper();
  return { ...rtlRender(ui, { wrapper: Wrapper }), queryClient };
}

/**
 * MeetingsList — dense meetings index. Contract:
 *  - derived title: first sentence of summary → URL host → "Untitled meeting";
 *  - status → label (done=transcribed, processing, pending, failed, scheduled);
 *  - only "done" meetings link to /meetings/[botId];
 *  - search is SERVER-SIDE: typing (debounced) re-runs useMeetingsList with the
 *    new filters; the hook returns the already-filtered rows;
 *  - status filter chips re-run the hook with { status };
 *  - loading shows skeletons; error shows a message.
 *
 * useMeetingsList is mocked — we isolate the list UI and capture the filters it
 * requests. The mock returns { flat, ...infiniteQueryShape }.
 */

const lastFilters = vi.fn();
let rows: unknown[] = [];
let state = { isLoading: false, error: null as unknown };

vi.mock("@/features/meetings/model/queries", () => ({
  useMeetingsList: (filters: unknown) => {
    lastFilters(filters);
    return {
      flat: rows,
      isLoading: state.isLoading,
      error: state.error,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    };
  },
}));

const reprocessMeeting = vi.fn();
const cancelScheduledMeeting = vi.fn();
vi.mock("@/features/meetings/api/actions", () => ({
  reprocessMeeting: (...a: unknown[]) => reprocessMeeting(...a),
  cancelScheduledMeeting: (...a: unknown[]) => cancelScheduledMeeting(...a),
}));

import { MeetingsList } from "@/features/meetings/ui/MeetingsList";

function meeting(over: Record<string, unknown> = {}) {
  return {
    botId: "bot-1",
    status: "done",
    meetingUrl: "https://meet.google.com/abc-defg",
    summary: "Q3 roadmap sync locked scope. More text after.",
    participantCount: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    joinAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  state = { isLoading: false, error: null };
});

describe("MeetingsList — derived title", () => {
  it("uses the first sentence of the summary", () => {
    rows = [meeting()];
    render(<MeetingsList />);
    expect(screen.getByText("Q3 roadmap sync locked scope.")).toBeInTheDocument();
  });

  it("falls back to the meetingUrl host when there is no summary", () => {
    rows = [meeting({ summary: null })];
    render(<MeetingsList />);
    expect(screen.getByText(/meet\.google\.com/)).toBeInTheDocument();
  });

  it("shows 'Untitled meeting' with no summary and no URL", () => {
    rows = [meeting({ summary: null, meetingUrl: null })];
    render(<MeetingsList />);
    expect(screen.getByText("Untitled meeting")).toBeInTheDocument();
  });
});

describe("MeetingsList — status and link", () => {
  it("done links to /meetings/[botId] and shows 'transcribed'", () => {
    rows = [meeting({ botId: "bot-9" })];
    render(<MeetingsList />);
    const link = screen.getByRole("link", { name: /open notebook/i });
    expect(link).toHaveAttribute("href", "/meetings/bot-9");
    expect(within(link).getByText(/transcribed/i)).toBeInTheDocument();
  });

  it("processing is NOT a link and shows 'processing'", () => {
    rows = [meeting({ status: "processing" })];
    render(<MeetingsList />);
    expect(screen.queryByRole("link", { name: /open notebook/i })).toBeNull();
    // The row label (not a chip button) carries the status text.
    expect(
      screen.getByText(/processing/i, { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("failed shows 'failed' and is not a link", () => {
    rows = [meeting({ status: "failed" })];
    render(<MeetingsList />);
    expect(screen.queryByRole("link", { name: /open notebook/i })).toBeNull();
    // A "failed" filter chip also exists; assert the row's label span, not it.
    expect(
      screen.getByText(/failed/i, { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("scheduled shows 'scheduled' and is not a link (future meeting)", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    rows = [
      meeting({ status: "scheduled", summary: null, joinAt: future, createdAt: future }),
    ];
    render(<MeetingsList />);
    expect(screen.queryByRole("link", { name: /open notebook/i })).toBeNull();
    expect(screen.getByText(/scheduled/i)).toBeInTheDocument();
  });
});

describe("MeetingsList — server-side search", () => {
  it("typing re-runs the hook with the debounced query", async () => {
    rows = [meeting()];
    const user = userEvent.setup();
    render(<MeetingsList />);

    // Initial render: no query filter.
    expect(lastFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: undefined }),
    );

    await user.type(screen.getByPlaceholderText(/search meetings/i), "budget");

    // Debounced (300ms) → the hook eventually receives q: "budget".
    await waitFor(() =>
      expect(lastFilters).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "budget" }),
      ),
    );
  });

  it("empty result while filtering shows the 'no match' state", async () => {
    rows = [];
    const user = userEvent.setup();
    render(<MeetingsList />);
    await user.type(screen.getByPlaceholderText(/search meetings/i), "zzz");
    await waitFor(() =>
      expect(screen.getByText(/no meetings match/i)).toBeInTheDocument(),
    );
  });
});

describe("MeetingsList — status filter", () => {
  it("clicking a status chip re-runs the hook with that status", async () => {
    rows = [meeting()];
    const user = userEvent.setup();
    render(<MeetingsList />);

    await user.click(screen.getByRole("button", { name: /^failed$/i }));
    expect(lastFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });
});

describe("MeetingsList — recovery actions", () => {
  it("failed row shows a reprocess button that calls reprocessMeeting", async () => {
    reprocessMeeting.mockResolvedValue({ ok: true });
    rows = [meeting({ botId: "bad", status: "failed" })];
    const user = userEvent.setup();
    render(<MeetingsList />);

    await user.click(
      screen.getByRole("button", { name: /reprocess meeting/i }),
    );
    expect(reprocessMeeting).toHaveBeenCalledWith("bad");
  });

  it("scheduled row shows a cancel button that calls cancelScheduledMeeting", async () => {
    cancelScheduledMeeting.mockResolvedValue({ ok: true });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    rows = [
      meeting({
        botId: "sch",
        status: "scheduled",
        summary: null,
        joinAt: future,
        createdAt: future,
      }),
    ];
    const user = userEvent.setup();
    render(<MeetingsList />);

    await user.click(
      screen.getByRole("button", { name: /cancel scheduled meeting/i }),
    );
    expect(cancelScheduledMeeting).toHaveBeenCalledWith("sch");
  });

  it("done/processing rows have no recovery button", () => {
    rows = [meeting({ status: "done" })];
    render(<MeetingsList />);
    expect(
      screen.queryByRole("button", { name: /reprocess|cancel scheduled/i }),
    ).toBeNull();
  });
});

describe("MeetingsList — states", () => {
  it("empty list (no filters) invites sending a bot", () => {
    rows = [];
    render(<MeetingsList />);
    expect(screen.getByText(/no meetings yet/i)).toBeInTheDocument();
  });

  it("loading shows the 'loading' counter", () => {
    rows = [];
    state = { isLoading: true, error: null };
    render(<MeetingsList />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("error shows a failure message", () => {
    rows = [];
    state = { isLoading: false, error: new Error("boom") };
    render(<MeetingsList />);
    expect(screen.getByText(/could not load meetings/i)).toBeInTheDocument();
  });
});
