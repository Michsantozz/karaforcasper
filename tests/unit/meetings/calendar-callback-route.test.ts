import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Google OAuth callback route — the account-linking entry point. Security
 * contract: the userId MUST come from the HMAC-signed `state`, never the raw
 * query, so a forged state can't link a calendar to another user; and dedup by
 * (platform, email) must reconnect an existing calendar instead of creating a
 * duplicate. Untested until now. All network deps mocked.
 */
const exchangeCode = vi.fn();
const fetchUserEmail = vi.fn();
const verifyOAuthState = vi.fn();
const findCalendarByEmail = vi.fn();
const createCalendar = vi.fn();
const reconnectCalendar = vi.fn();
const saveCalendarMapping = vi.fn();

vi.mock("@/server/recall/google-oauth", () => ({
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
  fetchUserEmail: (...a: unknown[]) => fetchUserEmail(...a),
  googleClientId: () => "gid",
  googleClientSecret: () => "gsecret",
}));
vi.mock("@/server/recall/calendars", () => ({
  createCalendar: (...a: unknown[]) => createCalendar(...a),
  reconnectCalendar: (...a: unknown[]) => reconnectCalendar(...a),
}));
vi.mock("@/server/recall/calendar-repository", () => ({
  findCalendarByEmail: (...a: unknown[]) => findCalendarByEmail(...a),
  saveCalendarMapping: (...a: unknown[]) => saveCalendarMapping(...a),
}));
vi.mock("@/server/recall/oauth-state", () => ({
  verifyOAuthState: (...a: unknown[]) => verifyOAuthState(...a),
}));

const call = (qs: string) =>
  import("@/_app/api-routes/calendar-google-callback").then(({ GET }) =>
    GET(new Request(`https://app.com/api/calendar/google/callback${qs}`)),
  );

beforeEach(() => {
  vi.clearAllMocks();
  verifyOAuthState.mockReturnValue("u1");
  exchangeCode.mockResolvedValue({ refreshToken: "rt", accessToken: "at" });
  fetchUserEmail.mockResolvedValue("user@x.com");
  createCalendar.mockResolvedValue({ id: "cal-1", status: "connected", platform_email: "user@x.com" });
  reconnectCalendar.mockResolvedValue({ id: "cal-1", status: "connected", platform_email: "user@x.com" });
  findCalendarByEmail.mockResolvedValue(null);
});

describe("calendar OAuth callback — validation", () => {
  it("400 when the provider returned an error", async () => {
    const res = await call("?error=access_denied");
    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("400 when code or state is missing", async () => {
    expect((await call("?code=abc")).status).toBe(400); // no state
    expect((await call("?state=xyz")).status).toBe(400); // no code
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("403 on a forged/invalid state — no token exchange", async () => {
    verifyOAuthState.mockImplementation(() => {
      throw new Error("bad_signature");
    });
    const res = await call("?code=abc&state=forged");
    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveCalendarMapping).not.toHaveBeenCalled();
  });
});

describe("calendar OAuth callback — linking uses the VERIFIED userId", () => {
  it("persists the mapping under the userId from the signed state, not the query", async () => {
    verifyOAuthState.mockReturnValue("real-user");
    const res = await call("?code=abc&state=signed&user_id=attacker");
    expect(res.status).toBe(307); // redirect
    expect(saveCalendarMapping).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "real-user" }),
    );
  });

  it("creates a new calendar when none exists for (platform,email)", async () => {
    findCalendarByEmail.mockResolvedValue(null);
    await call("?code=abc&state=signed");
    expect(createCalendar).toHaveBeenCalledOnce();
    expect(reconnectCalendar).not.toHaveBeenCalled();
  });

  it("reconnects (dedup) an existing calendar instead of duplicating", async () => {
    findCalendarByEmail.mockResolvedValue({ recallCalendarId: "existing" });
    await call("?code=abc&state=signed");
    expect(reconnectCalendar).toHaveBeenCalledWith("existing", expect.any(Object));
    expect(createCalendar).not.toHaveBeenCalled();
  });

  it("502 when the token exchange fails", async () => {
    exchangeCode.mockRejectedValue(new Error("google 500"));
    const res = await call("?code=abc&state=signed");
    expect(res.status).toBe(502);
    expect(saveCalendarMapping).not.toHaveBeenCalled();
  });
});
