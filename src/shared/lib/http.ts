import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * HTTP edge helpers for routes: CSRF protection via Origin and zod body
 * parsing. Centralized so every mutating route applies the same policy.
 */

/**
 * Casper public key. Two curves, DIFFERENT LENGTHS:
 *  - ED25519:   01 + 64 hex (32 bytes) = 66 hex
 *  - SECP256K1: 02 + 66 hex (33 bytes) = 68 hex
 */
export const publicKeyHexSchema = z
  .string()
  .regex(/^(?:01[0-9a-f]{64}|02[0-9a-f]{66})$/i, "invalid public key");

/** Signature: 128 hex (raw) or 130 (with tag). */
export const signatureHexSchema = z
  .string()
  .regex(/^(01|02)?[0-9a-f]{128}$/i, "invalid signature");

/**
 * CSRF protection: on mutating requests, requires the Origin header (when
 * present) to match the request's host. Blocks cross-site POSTs. Same-origin
 * requests from the app itself (fetch) always pass.
 *
 * Returns a 403 NextResponse if invalid, or null if OK.
 */
export async function assertSameOrigin(): Promise<NextResponse | null> {
  const h = await headers();
  const origin = h.get("origin");
  // No Origin (e.g. direct GET navigation, some server-side clients) → no
  // classic CSRF vector; let it pass. CSRF requires a cross-site Origin.
  if (!origin) return null;

  const host = h.get("host");
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return NextResponse.json({ error: "csrf_origin_mismatch" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "csrf_invalid_origin" }, { status: 403 });
  }
  return null;
}

/**
 * Parses + validates the JSON body against a zod schema. Returns `{ data }`
 * or `{ response }` (error NextResponse) — the caller early-returns on error.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<{ data: z.infer<T>; response?: never } | { data?: never; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      response: NextResponse.json({ error: "invalid_json" }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: NextResponse.json(
        {
          error: "validation_failed",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }
  return { data: parsed.data };
}
