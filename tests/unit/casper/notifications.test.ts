import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * notifications.ts — a maior parte é passthrough de drizzle (insert/update/select);
 * a lógica REAL que vale teste está em createNotificationsForUsers:
 *  - deduplica userIds (não cria 2 notificações pro mesmo signatário);
 *  - ignora lista vazia (não chama o DB à toa).
 *
 * db é mockado — validamos a preparação dos dados, não o driver Postgres.
 */

const insertValues = vi.fn();
vi.mock("@/shared/db", () => ({
  db: {
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
  },
}));
vi.mock("@/shared/db/schema", () => ({ notifications: {} }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.resetModules());

describe("createNotificationsForUsers — dedup e lista vazia", () => {
  it("deduplica userIds repetidos (1 notificação por usuário)", async () => {
    insertValues.mockResolvedValue(undefined);
    const { createNotificationsForUsers } = await import("@/server/casper/notifications");
    await createNotificationsForUsers({
      userIds: ["u1", "u2", "u1", "u2", "u1"],
      type: "signature_requested",
      message: "assine",
    });

    expect(insertValues).toHaveBeenCalledTimes(1);
    const rows = insertValues.mock.calls[0][0] as Array<{ userId: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual(["u1", "u2"]);
  });

  it("lista vazia não toca o DB", async () => {
    const { createNotificationsForUsers } = await import("@/server/casper/notifications");
    await createNotificationsForUsers({
      userIds: [],
      type: "signature_requested",
      message: "assine",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("propaga type/message/requestId para cada linha", async () => {
    insertValues.mockResolvedValue(undefined);
    const { createNotificationsForUsers } = await import("@/server/casper/notifications");
    await createNotificationsForUsers({
      userIds: ["a", "b"],
      type: "request_ready",
      message: "quórum atingido",
      requestId: "req-7",
    });
    const rows = insertValues.mock.calls[0][0] as Array<{
      type: string;
      message: string;
      requestId: string | null;
    }>;
    for (const r of rows) {
      expect(r.type).toBe("request_ready");
      expect(r.message).toBe("quórum atingido");
      expect(r.requestId).toBe("req-7");
    }
  });
});

describe("createNotification — linha única", () => {
  it("insere com requestId null por padrão", async () => {
    insertValues.mockResolvedValue(undefined);
    const { createNotification } = await import("@/server/casper/notifications");
    await createNotification({
      userId: "u1",
      type: "meeting_summary_ready",
      message: "ata pronta",
    });
    const row = insertValues.mock.calls[0][0] as { requestId: string | null; userId: string };
    expect(row.userId).toBe("u1");
    expect(row.requestId).toBeNull();
  });
});
