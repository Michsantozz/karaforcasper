import { sql } from "drizzle-orm";
import { db } from "@/shared/db";

// Health check pro orquestrador (Docker/K8s). Sempre dinâmico — nunca cacheado.
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness num único endpoint.
 *
 * - Liveness: se este handler responde, o processo Node está vivo.
 * - Readiness: `?ready=1` (ou `?deep=1`) também pinga o Postgres com `SELECT 1`.
 *   Sem a dependência up, retorna 503 → orquestrador não roteia tráfego pro pod.
 *
 * Sonda liveness com `GET /api/health` (rápido, sem I/O externo) e readiness
 * com `GET /api/health?ready=1`. Separar evita que um DB lento derrube o pod
 * por falha de liveness (restart loop) quando ele só está temporariamente not-ready.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep =
    url.searchParams.has("ready") || url.searchParams.has("deep");

  if (!deep) {
    return Response.json({ status: "ok" });
  }

  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", db: "up" });
  } catch {
    // Não vaza detalhe do erro (mensagem/host) na resposta pública.
    return Response.json({ status: "error", db: "down" }, { status: 503 });
  }
}
