import { NextResponse } from "next/server";
import { getDayAvailability } from "@/server/recall/availability";
import { getSession } from "@/features/auth/model/session";

/**
 * Disponibilidade de um DIA para o usuário autenticado — a grade de horário
 * comercial já classificada (livre/ocupado) contra a agenda real.
 *
 * Consumida pelo PickDateToolUI (client): a UI não pode importar `server/`, então
 * pede aqui. Query: `date` (yyyy-mm-dd, obrigatório) e `tz` (IANA, opcional —
 * default America/Sao_Paulo).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dateIso = url.searchParams.get("date");
  const timeZone = url.searchParams.get("tz") || "America/Sao_Paulo";

  if (!dateIso || !DATE_RE.test(dateIso)) {
    return NextResponse.json(
      { error: "bad date", detail: "esperado ?date=yyyy-mm-dd" },
      { status: 400 },
    );
  }
  // Valida o IANA tz cedo — um tz inválido explodiria dentro do Intl.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return NextResponse.json({ error: "bad timezone" }, { status: 400 });
  }

  try {
    const day = await getDayAvailability({
      userId: session.user.id,
      dateIso,
      timeZone,
    });
    return NextResponse.json(day);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "availability failed", detail: message },
      { status: 502 },
    );
  }
}
