"use client";

import { useEffect, useState } from "react";
import { CalendarIcon, CheckIcon, ClockIcon, LoaderIcon } from "lucide-react";
import {
  makeAssistantTool,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Calendar } from "@/shared/ui/calendar";
import { cn } from "@/shared/lib/utils";

/**
 * pick_date — frontend tool que renderiza um CALENDÁRIO + SELETOR DE HORÁRIO
 * clicável no chat, com DISPONIBILIDADE REAL da agenda do usuário.
 *
 * Fluxo (human-in-the-loop, igual connect_wallet):
 *  1. O agente chama pick_date quando precisa que o usuário escolha dia/hora.
 *  2. `execute` roda no browser e devolve um estado "aguardando" — não bloqueia.
 *  3. `render` mostra o <Calendar> + coluna de horários. Ao escolher um dia,
 *     busca GET /api/calendar/availability?date&tz e marca cada horário como
 *     LIVRE (clicável) ou OCUPADO (visível, desabilitado, com o motivo). O
 *     usuário só consegue clicar em horário livre → addToolResult → volta ao
 *     agente.
 *  4. sendAutomaticallyWhen ligado: o agente CONTINUA o loop sozinho.
 *
 * Diferença crítica vs. a versão anterior: os horários NÃO são mais uma grade
 * fixa que ignora a agenda. Antes o usuário clicava num horário já ocupado e o
 * create_calendar_event gerava conflito silencioso — agora a UI é honesta.
 */

type PickDateArgs = {
  /** Texto curto do que o usuário está escolhendo (ex.: "dia da reunião"). */
  prompt?: string;
  /** ISO mínimo selecionável (default: hoje — não deixa escolher passado). */
  minIso?: string;
};

type PickDateResult = {
  picked: boolean;
  /** Data escolhida (yyyy-mm-dd). */
  dateIso: string | null;
  /** Hora escolhida (HH:mm). */
  timeHm: string | null;
  /** Data+hora combinadas em ISO local (yyyy-mm-ddTHH:mm). */
  datetimeIso: string | null;
};

/** Um slot vindo da API de disponibilidade. */
type Slot = {
  timeHm: string;
  datetimeIso: string;
  busy: boolean;
  reason?: string;
};

type AvailabilityResponse = {
  dateIso: string;
  timeZone: string;
  slots: Slot[];
  noCalendar: boolean;
};

/** Fuso do navegador (ex.: "America/Sao_Paulo"), com fallback para BRT. */
function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  } catch {
    return "America/Sao_Paulo";
  }
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

/** ISO yyyy-mm-dd no fuso local (sem deslocar o dia por UTC). */
function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Registro de Promises pendentes por toolCallId. `execute` cria uma Promise que
 * NÃO resolve até o usuário clicar — assim a tool call só "completa" após a
 * escolha real, e o sendAutomaticallyWhen não reenvia um picked:false prematuro.
 */
const pending = new Map<string, (r: PickDateResult) => void>();

export function PickDateCard({
  args,
  result,
  toolCallId,
}: ToolCallMessagePartProps<PickDateArgs, PickDateResult>) {
  const [day, setDay] = useState<Date | undefined>();
  const [time, setTime] = useState<string | undefined>();
  const [done, setDone] = useState<PickDateResult | undefined>();

  const [avail, setAvail] = useState<AvailabilityResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Fuso do navegador, resolvido uma vez (inicializador lazy do useState).
  const [tz] = useState(browserTz);

  // Ao escolher um dia, busca a disponibilidade real dele. Cancela via flag se
  // o usuário trocar de dia antes da resposta chegar (evita race de estado).
  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    const dateIso = toLocalIso(day);
    // Resets fora do corpo síncrono do effect (regra react-hooks/set-state-in-effect):
    // um microtask agenda o estado inicial de carregamento antes do fetch resolver.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(undefined);
      setTime(undefined);
      setAvail(undefined);
    });
    fetch(
      `/api/calendar/availability?date=${dateIso}&tz=${encodeURIComponent(tz)}`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`falha ${r.status}`);
        return (await r.json()) as AvailabilityResponse;
      })
      .then((data) => {
        if (!cancelled) setAvail(data);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "erro ao carregar horários");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [day, tz]);

  // Já respondido: mostra o que foi escolhido, some o seletor.
  const settled = result?.picked ? result : done;
  if (settled?.picked && settled.dateIso) {
    const d = new Date(`${settled.dateIso}T00:00:00`);
    return (
      <ToolCard label="horário escolhido" tone="success" meta="ok">
        <p className="font-mono text-sm capitalize">
          {fmtDay(d)}
          {settled.timeHm ? (
            <span className="text-(--thread-accent-primary)">
              {" "}
              · {settled.timeHm}
            </span>
          ) : null}
        </p>
      </ToolCard>
    );
  }

  const min = args.minIso ? new Date(`${args.minIso}T00:00:00`) : new Date();
  min.setHours(0, 0, 0, 0);

  /** Só um slot LIVRE confirma. Resolve a Promise do execute → a tool call
   *  completa e o agente continua o loop (sendAutomaticallyWhen). */
  function confirm(nextDay: Date, slot: Slot) {
    if (slot.busy) return;
    const dateIso = toLocalIso(nextDay);
    const res: PickDateResult = {
      picked: true,
      dateIso,
      timeHm: slot.timeHm,
      datetimeIso: slot.datetimeIso,
    };
    setTime(slot.timeHm);
    setDone(res);
    const resolve = pending.get(toolCallId);
    if (resolve) {
      pending.delete(toolCallId);
      resolve(res);
    }
  }

  const slots = avail?.slots ?? [];
  const freeCount = slots.filter((s) => !s.busy).length;

  return (
    <ToolCard label={args.prompt ?? "escolha dia e horário"}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {/* Calendário */}
        <Calendar
          mode="single"
          selected={day}
          onSelect={(d) => setDay(d ?? undefined)}
          disabled={{ before: min }}
          className="rounded-[5px] border bg-background p-2"
        />

        {/* Coluna de horários (scrollável) */}
        <div className="flex flex-col rounded-[5px] border bg-background">
          <div className="flex items-center justify-between gap-1.5 border-b px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {loading ? (
                <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
              ) : (
                <ClockIcon className="size-3.5" />
              )}
              {day ? (
                <span className="capitalize text-foreground">
                  {day.toLocaleDateString("pt-BR", {
                    weekday: "long",
                    day: "2-digit",
                  })}
                </span>
              ) : (
                "horário"
              )}
            </span>
            {day && !loading && !error ? (
              <span>{freeCount} livre{freeCount === 1 ? "" : "s"}</span>
            ) : null}
          </div>

          <div className="grid max-h-[248px] grid-cols-2 gap-1.5 overflow-y-auto p-2 sm:w-[184px] sm:grid-cols-1">
            {!day ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">
                escolha um dia
              </p>
            ) : error ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-(--thread-accent-secondary)">
                {error}
              </p>
            ) : loading ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">
                carregando…
              </p>
            ) : freeCount === 0 ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">
                sem horários livres neste dia
              </p>
            ) : (
              slots.map((slot) => {
                const active = time === slot.timeHm && !slot.busy;
                return (
                  <button
                    key={slot.timeHm}
                    type="button"
                    disabled={slot.busy}
                    title={slot.busy ? slot.reason ?? "ocupado" : undefined}
                    onClick={() => day && confirm(day, slot)}
                    className={cn(
                      "rounded-[5px] border px-2 py-1.5 text-center font-mono text-sm transition-colors",
                      slot.busy
                        ? "cursor-not-allowed border-dashed text-muted-foreground/60 line-through opacity-60"
                        : active
                          ? "border-transparent bg-(--thread-accent-primary) text-background"
                          : "bg-background hover:bg-(--thread-frame-outer)",
                    )}
                  >
                    {slot.timeHm}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
        <span>
          {!day
            ? "escolha um dia, depois o horário"
            : avail?.noCalendar
              ? "agenda não conectada — horários não checados"
              : "riscado = ocupado na sua agenda"}
        </span>
        <span>fuso: {avail?.timeZone ?? tz}</span>
      </div>
    </ToolCard>
  );
}

export const PickDateTool = makeAssistantTool<PickDateArgs, PickDateResult>({
  toolName: "pick_date",
  type: "frontend",
  description:
    "Mostra um CALENDÁRIO + seletor de HORÁRIO clicável no chat para o usuário escolher dia e hora. Os horários (09:00–18:00) refletem a AGENDA REAL do usuário: os ocupados aparecem riscados e não-clicáveis — o usuário só escolhe horário livre. Use SEMPRE que precisar de uma data/horário do usuário (ex.: quando enviar o bot, agendar reunião) em vez de pedir por texto. Retorna { picked, dateIso (yyyy-mm-dd), timeHm (HH:mm), datetimeIso (yyyy-mm-ddTHH:mm) } — o horário retornado JÁ está livre. Depois use datetimeIso (ex.: como join_at em send_bot_to_meeting / schedule_bot_for_event). minIso (opcional) define o dia mínimo selecionável.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      minIso: { type: "string" },
    },
    additionalProperties: false,
  },
  // execute NÃO resolve na hora: retorna uma Promise que só completa quando o
  // usuário clica um horário LIVRE no render (confirm chama o resolver). Assim a
  // tool call fica "pendente" e o sendAutomaticallyWhen não reenvia um
  // picked:false prematuro (que fazia o agente dizer "você fechou sem escolher").
  execute: async (_args, { toolCallId }) =>
    new Promise<PickDateResult>((resolve) => {
      pending.set(toolCallId, resolve);
    }),
  render: PickDateCard,
});

/* ── card visual (espelha o ToolCard dos outros ToolUIs) ──────────────── */

type Tone = "default" | "success";

function ToolCard({
  label,
  meta,
  tone = "default",
  running = false,
  children,
}: {
  label: string;
  meta?: string;
  tone?: Tone;
  running?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="my-2 rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          {running ? (
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
          ) : (
            <CalendarIcon className="size-3.5" />
          )}
          meeting / {label}
        </span>
        {tone === "success" ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
            <CheckIcon className="size-3" />
            {meta ?? "done"}
          </span>
        ) : meta ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-[1px] bg-(--thread-accent-secondary)",
              )}
            />
            {meta}
          </span>
        ) : null}
      </div>
      {children && (
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-2">
          {children}
        </div>
      )}
    </div>
  );
}
