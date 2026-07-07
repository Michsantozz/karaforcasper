import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Helpers de borda HTTP para as rotas: proteção CSRF por Origin e parse de body
 * com zod. Centraliza para todas as rotas mutáveis aplicarem a mesma política.
 */

/**
 * Public key Casper. Duas curvas, COMPRIMENTOS DIFERENTES:
 *  - ED25519:   01 + 64 hex (32 bytes) = 66 hex
 *  - SECP256K1: 02 + 66 hex (33 bytes) = 68 hex
 */
export const publicKeyHexSchema = z
  .string()
  .regex(/^(?:01[0-9a-f]{64}|02[0-9a-f]{66})$/i, "public key inválida");

/** Assinatura: 128 hex (crua) ou 130 (com tag). */
export const signatureHexSchema = z
  .string()
  .regex(/^(01|02)?[0-9a-f]{128}$/i, "assinatura inválida");

/**
 * Proteção CSRF: em requests mutáveis, exige que o header Origin (quando
 * presente) bata com o host da requisição. Bloqueia POSTs cross-site. Requests
 * same-origin do próprio app (fetch) sempre passam.
 *
 * Retorna uma NextResponse 403 se inválido, ou null se OK.
 */
export async function assertSameOrigin(): Promise<NextResponse | null> {
  const h = await headers();
  const origin = h.get("origin");
  // Sem Origin (ex.: navegação direta GET, alguns clients server-side) → não há
  // vetor CSRF clássico; deixamos passar. CSRF exige um Origin cross-site.
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
 * Parse + valida o body JSON contra um schema zod. Retorna `{ data }` ou
 * `{ response }` (NextResponse de erro) — o caller faz early-return no erro.
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
