import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * listMeetingRecordsPage — the paginated "library" query. Covers:
 *  - keyset pagination: fetches limit+1 and derives nextCursor from the last
 *    item when a further page exists (null when exhausted);
 *  - server-side search + status conditions are added to the WHERE tree;
 *  - the cursor condition (createdAt < cursor) is applied;
 *  - isMeetingStatus validates against the enum.
 *
 * scopedDb() is mocked with a chainable fake builder; we inspect where/limit.
 * The RLS boundary (withUserScope) is exercised at the route/tool level.
 */

const capture: { where: unknown; limit: number | null } = {
  where: null,
  limit: null,
};
let rows: Array<Record<string, unknown>> = [];

const qb = {
  select: () => qb,
  from: () => qb,
  where: (w: unknown) => {
    capture.where = w;
    return qb;
  },
  orderBy: () => qb,
  limit: (n: number) => {
    capture.limit = n;
    return Promise.resolve(rows);
  },
};

vi.mock("@/shared/db/rls", () => ({ scopedDb: () => qb }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ op: "and", args: a }),
  or: (...a: unknown[]) => ({ op: "or", args: a }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  ilike: (col: unknown, pattern: unknown) => ({ op: "ilike", col, pattern }),
  desc: (col: unknown) => ({ op: "desc", col }),
  inArray: (...a: unknown[]) => ({ op: "inArray", args: a }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  sql: (...a: unknown[]) => ({ op: "sql", args: a }),
}));
vi.mock("@/shared/db/schema", () => ({
  meetingRecords: {
    botId: { name: "bot_id" },
    status: { name: "status" },
    meetingUrl: { name: "meeting_url" },
    summary: { name: "summary" },
    overview: { name: "overview" },
    transcript: { name: "transcript" },
    talkShares: { name: "talk_shares" },
    createdAt: { name: "created_at" },
    updatedAt: { name: "updated_at" },
  },
  meetingRecordStatusEnum: {
    enumValues: ["pending", "processing", "done", "failed"],
  },
}));

async function load() {
  return import("@/server/recall/meeting-repository");
}

/** Builds n rows with descending createdAt (newest first, like the query). */
function makeRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    botId: `bot-${i}`,
    status: "done",
    meetingUrl: null,
    summary: `s${i}`,
    talkShares: [{ name: "A", share: 1 }],
    createdAt: new Date(Date.UTC(2026, 0, 100 - i)),
    updatedAt: new Date(Date.UTC(2026, 0, 100 - i)),
  }));
}

beforeEach(() => {
  capture.where = null;
  capture.limit = null;
  rows = [];
});

describe("listMeetingRecordsPage — pagination", () => {
  it("fetches limit+1 and returns nextCursor when a further page exists", async () => {
    // limit=2 → asks for 3; return 3 → hasMore.
    rows = makeRows(3);
    const { listMeetingRecordsPage } = await load();

    const page = await listMeetingRecordsPage({ limit: 2 });

    expect(capture.limit).toBe(3);
    expect(page.items).toHaveLength(2);
    // nextCursor = createdAt of the last RETURNED item (2nd row), ISO string.
    expect(page.nextCursor).toBe(rows[1].createdAt instanceof Date
      ? (rows[1].createdAt as Date).toISOString()
      : null);
    // participantCount derived from talkShares length.
    expect(page.items[0].participantCount).toBe(1);
  });

  it("no further page → nextCursor null", async () => {
    rows = makeRows(2);
    const { listMeetingRecordsPage } = await load();

    const page = await listMeetingRecordsPage({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("clamps limit to 1..100", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    await listMeetingRecordsPage({ limit: 999 });
    expect(capture.limit).toBe(101); // 100 + 1

    await listMeetingRecordsPage({ limit: 0 });
    expect(capture.limit).toBe(2); // 1 + 1
  });
});

describe("listMeetingRecordsPage — filters", () => {
  it("adds ILIKE search, status eq, and cursor lt to the WHERE tree", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    await listMeetingRecordsPage({
      query: "pricing",
      status: "done",
      cursor: "2026-06-01T00:00:00.000Z",
    });

    const where = JSON.stringify(capture.where);
    expect(where).toContain("ilike");
    expect(where).toContain("pricing");
    // status eq + createdAt lt (cursor) present.
    expect(where).toContain('"op":"eq"');
    expect(where).toContain('"op":"lt"');
  });

  it("no filters → WHERE is undefined (unfiltered listing)", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();
    await listMeetingRecordsPage({});
    expect(capture.where).toBeUndefined();
  });
});

describe("isMeetingStatus", () => {
  it("accepts enum values, rejects others", async () => {
    const { isMeetingStatus } = await load();
    expect(isMeetingStatus("done")).toBe(true);
    expect(isMeetingStatus("failed")).toBe(true);
    expect(isMeetingStatus("scheduled")).toBe(false);
    expect(isMeetingStatus("bogus")).toBe(false);
  });
});
