import "server-only";
import { listCalendarEvents } from "./calendars";
import { listCalendarsByUser } from "./calendar-repository";
import { withUserScope } from "@/shared/db/rls";

/**
 * Motor de disponibilidade — calcula HORÁRIOS LIVRES cruzando a grade de
 * horário comercial com os eventos reais das agendas conectadas do usuário.
 *
 * Antes disso o pick_date no chat mostrava uma grade fixa 09:00–18:00 que
 * IGNORAVA a agenda: o usuário clicava num horário já ocupado e o
 * create_calendar_event criava um conflito silencioso. Aqui derivamos os
 * "busy ranges" (eventos existentes, sync via Recall) e subtraímos da grade,
 * marcando cada slot como livre ou ocupado — a UI passa a ser honesta.
 *
 * Álgebra de intervalos inspirada no cal.com (buildDateRanges + subtract), mas
 * enxuta: aqui só precisamos saber, para um DIA, quais slots batem em algum
 * evento. Não há working-hours por usuário, date overrides nem round-robin.
 */

/** Intervalo semiaberto [start, end) em epoch ms. */
export type Range = { start: number; end: number };

/** Um slot da grade, já classificado contra a agenda. */
export type Slot = {
  /** Horário no formato "HH:mm" (fuso do request). */
  timeHm: string;
  /** ISO local "yyyy-mm-ddTHH:mm" — o que o agente usa como join_at. */
  datetimeIso: string;
  /** true se colide com algum evento existente (ou já passou). */
  busy: boolean;
  /** Motivo do busy, quando houver (título/janela do evento em conflito). */
  reason?: string;
};

export type AvailabilityDay = {
  /** Dia consultado (yyyy-mm-dd) no fuso do request. */
  dateIso: string;
  /** IANA tz usado no cálculo (ex.: "America/Sao_Paulo"). */
  timeZone: string;
  slots: Slot[];
  /** true se o usuário não tem nenhuma agenda conectada (tudo vira "livre"). */
  noCalendar: boolean;
};

/** Grade de horário comercial — fixa (o agente não amplia). */
const BUSINESS_START_MIN = 9 * 60; // 09:00
const BUSINESS_END_MIN = 18 * 60; // 18:00
const SLOT_STEP_MIN = 60;
/** Duração assumida de um slot ao checar conflito (mesma do step). */
const SLOT_DURATION_MIN = SLOT_STEP_MIN;

/**
 * Merge de ranges sobrepostos/adjacentes. Ordena por início e funde quando o
 * próximo começa antes (ou no) fim do atual. O(n log n).
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** true se [start, end) intersecta algum dos busy ranges (assume ordenados/merged). */
export function overlaps(start: number, end: number, busy: Range[]): boolean {
  for (const b of busy) {
    if (b.start >= end) break; // ordenados: nada além cruza
    if (b.end > start) return true; // b.start < end && b.end > start
  }
  return false;
}

/**
 * Offset (em minutos) do fuso `timeZone` num dado instante. Positivo = a leste
 * de UTC. Usa Intl para respeitar DST — como o cal.com, evitamos libs de tz.
 */
function tzOffsetMinutes(timeZone: string, at: Date): number {
  // Formata o instante no fuso alvo e reconstrói um Date "como se fosse UTC";
  // a diferença para o instante real é o offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(at);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  // Intl às vezes devolve hour=24 à meia-noite; normaliza.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    hour,
    map.minute,
    map.second,
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Converte uma parede-relógio local (dia + minutos-do-dia no `timeZone`) para
 * epoch ms. Resolve o offset iterativamente (2 passes bastam para DST).
 */
function localWallToEpoch(
  dateIso: string,
  minutesOfDay: number,
  timeZone: string,
): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesOfDay * 60000;
  // 1º passe: offset no instante naive; 2º: reavalia no instante corrigido.
  let offset = tzOffsetMinutes(timeZone, new Date(naiveUtc));
  let epoch = naiveUtc - offset * 60000;
  offset = tzOffsetMinutes(timeZone, new Date(epoch));
  epoch = naiveUtc - offset * 60000;
  return epoch;
}

function hm(minutesOfDay: number): string {
  const h = String(Math.floor(minutesOfDay / 60)).padStart(2, "0");
  const m = String(minutesOfDay % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Busca os eventos das agendas do usuário que caem no dia pedido e os
 * transforma em busy ranges (epoch ms), já merged. Escopado ao usuário.
 *
 * Um evento entra se sua janela [start, end) intersecta o dia local — por isso
 * consultamos com uma folga de ±1 dia na query do Recall e filtramos aqui.
 */
async function getBusyRangesForDay(
  userId: string,
  dateIso: string,
  timeZone: string,
): Promise<{ busy: Range[]; events: Array<{ range: Range; title: string }>; noCalendar: boolean }> {
  const mappings = await withUserScope(userId, () => listCalendarsByUser(userId));
  if (mappings.length === 0) {
    return { busy: [], events: [], noCalendar: true };
  }

  const dayStart = localWallToEpoch(dateIso, 0, timeZone);
  const dayEnd = localWallToEpoch(dateIso, 24 * 60, timeZone);
  // Folga de 1 dia de cada lado para pegar eventos que cruzam a fronteira.
  const queryFrom = new Date(dayStart - 24 * 60 * 60 * 1000).toISOString();
  const queryTo = new Date(dayEnd + 24 * 60 * 60 * 1000).toISOString();

  const allEvents = (
    await Promise.all(
      mappings.map(async (m) => {
        const { results } = await listCalendarEvents({
          calendarId: m.recallCalendarId,
          isDeleted: false,
          startTimeGte: queryFrom,
          startTimeLte: queryTo,
        });
        return results;
      }),
    )
  ).flat();

  const events: Array<{ range: Range; title: string }> = [];
  for (const e of allEvents) {
    const start = Date.parse(e.start_time);
    const end = Date.parse(e.end_time);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // Só o que realmente intersecta o dia local.
    if (end <= dayStart || start >= dayEnd) continue;
    const title =
      (typeof e.raw?.summary === "string" && e.raw.summary) ||
      (e.meeting_platform ? `reunião (${e.meeting_platform})` : "evento ocupado");
    events.push({ range: { start, end }, title });
  }

  const busy = mergeRanges(events.map((e) => e.range));
  return { busy, events, noCalendar: false };
}

/**
 * Calcula a disponibilidade de um DIA: grade comercial classificada contra a
 * agenda real do usuário. Slots no passado viram busy (reason "já passou").
 */
export async function getDayAvailability(input: {
  userId: string;
  /** Dia local (yyyy-mm-dd). */
  dateIso: string;
  /** IANA tz do usuário (ex.: "America/Sao_Paulo"). */
  timeZone: string;
  /** Instante "agora" para descartar passado; default Date.now(). */
  now?: number;
}): Promise<AvailabilityDay> {
  const { userId, dateIso, timeZone } = input;
  const now = input.now ?? Date.now();

  const { busy, events, noCalendar } = await getBusyRangesForDay(
    userId,
    dateIso,
    timeZone,
  );

  const slots: Slot[] = [];
  for (let min = BUSINESS_START_MIN; min < BUSINESS_END_MIN; min += SLOT_STEP_MIN) {
    const slotStart = localWallToEpoch(dateIso, min, timeZone);
    const slotEnd = slotStart + SLOT_DURATION_MIN * 60000;
    const datetimeIso = `${dateIso}T${hm(min)}`;

    if (slotStart < now) {
      slots.push({ timeHm: hm(min), datetimeIso, busy: true, reason: "já passou" });
      continue;
    }

    const conflict = events.find(
      (e) => e.range.end > slotStart && e.range.start < slotEnd,
    );
    if (conflict || overlaps(slotStart, slotEnd, busy)) {
      slots.push({
        timeHm: hm(min),
        datetimeIso,
        busy: true,
        reason: conflict?.title ?? "ocupado",
      });
    } else {
      slots.push({ timeHm: hm(min), datetimeIso, busy: false });
    }
  }

  return { dateIso, timeZone, slots, noCalendar };
}
