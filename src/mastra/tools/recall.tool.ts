import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { recallFetch, RecallAdhocPoolError } from "@/server/recall/client";
import {
  findBotByDedupKey,
  saveBotMapping,
  deleteBotMapping,
  defaultDedupKey,
} from "@/server/recall/bot-repository";
import { summarizeMeeting } from "@/server/recall/summarize";
import { hasBalanceForMinutes } from "@/server/casper/billing";
import { getSession } from "@/features/auth/model/session";
import { withUserScope } from "@/shared/db/rls";

/**
 * Estimativa de duração (min) usada só no GATE de saldo antes de criar o bot —
 * o custo real é medido depois pela duração transcrita. Conservador de propósito.
 */
const ESTIMATED_MEETING_MINUTES = Number(
  process.env.BILLING_ESTIMATED_MINUTES ?? 30,
);

/**
 * Tools de "front-desk" de bots Recall.ai — escrita via REST.
 *
 * Leitura rica (recordings, transcript, calendar) já vem das tools do MCP
 * recall-ai (read-only). Estas tools cobrem o que o MCP NÃO faz: criar, agendar,
 * controlar e remover bots, com deduplicação no DB do app.
 *
 * Convenção de receipt: as tools retornam { ok, botId, ... } — não despejam o
 * recording/transcript inteiro no resultado (fronteira capability).
 */

/** Artefato de mídia do recording (transcript/áudio/vídeo). */
type MediaArtifact = {
  id?: string;
  status?: { code?: string };
  data?: { download_url?: string };
} | null;

/** Artefato participant_events: expõe URLs de download de participantes/timeline. */
type ParticipantEventsArtifact = {
  status?: { code?: string };
  data?: {
    participants_download_url?: string;
    speaker_timeline_download_url?: string;
    participant_events_download_url?: string;
  };
} | null;

type RecallRecording = {
  id: string;
  status?: { code?: string };
  media_shortcuts?: {
    transcript?: MediaArtifact;
    video_mixed?: MediaArtifact;
    audio_mixed?: MediaArtifact;
    participant_events?: ParticipantEventsArtifact;
  };
};

/** Shape parcial do bot do Recall (só o que consumimos no receipt). */
type RecallBot = {
  id: string;
  status_changes?: Array<{ code?: string; created_at?: string }>;
  join_at?: string | null;
  meeting_url?: unknown;
  recordings?: RecallRecording[];
};

function latestStatus(bot: RecallBot): string | undefined {
  const changes = bot.status_changes;
  return changes?.[changes.length - 1]?.code;
}

/** Segmento bruto de transcript: participante + palavras com timestamps. */
type TranscriptSegment = {
  participant?: { name?: string | null };
  words?: Array<{
    text?: string;
    start_timestamp?: { relative?: number } | null;
    end_timestamp?: { relative?: number } | null;
  }>;
};

/**
 * Baixa e parseia a transcrição de um bot.
 *
 * Retorna o estado da transcrição e (se pronta) os segmentos brutos. Compartilhado
 * por get_transcript (texto legível) e summarize_meeting (input do LLM).
 */
async function loadTranscript(botId: string): Promise<{
  bot: RecallBot;
  state: "ready" | "processing" | "none";
  segments: TranscriptSegment[];
}> {
  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  });

  const transcript = bot.recordings?.[0]?.media_shortcuts?.transcript;
  if (!transcript) return { bot, state: "none", segments: [] };

  const url = transcript.data?.download_url;
  if (transcript.status?.code !== "done" || !url) {
    return { bot, state: "processing", segments: [] };
  }

  const res = await fetch(url);
  const segments = (await res.json()) as TranscriptSegment[];
  return { bot, state: "ready", segments };
}

/** Monta texto "participante: fala" + conjunto de speakers a partir dos segmentos. */
function renderTranscript(segments: TranscriptSegment[]): {
  text: string;
  speakers: string[];
} {
  const speakers = new Set<string>();
  const lines = segments.map((seg) => {
    const who = seg.participant?.name ?? "Desconhecido";
    speakers.add(who);
    const text = (seg.words ?? []).map((w) => w.text ?? "").join(" ").trim();
    return `${who}: ${text}`;
  });
  return { text: lines.join("\n"), speakers: [...speakers] };
}

/**
 * Agenda (ou reutiliza) um bot para entrar numa meeting.
 *
 * - join_at > 10 min no futuro → scheduled (join garantido).
 * - join_at omitido / <= 10 min → ad-hoc (pode falhar com 507; retentar ~30s).
 * Deduplica por dedup_key: se já existe bot para a meeting, reusa em vez de criar.
 */
export const scheduleRecallBotTool = createTool({
  id: "schedule_recall_bot",
  description:
    "Agenda ou inicia um bot do Recall.ai para entrar numa reunião (Zoom/Meet/Teams/etc.). " +
    "Passe join_at (ISO 8601, >10min no futuro) para agendar com join garantido, ou omita para entrar agora (ad-hoc). " +
    "Deduplica automaticamente: não cria bot duplicado para a mesma reunião.",
  inputSchema: z.object({
    meetingUrl: z.url().describe("URL da reunião"),
    joinAt: z.iso
      .datetime()
      .optional()
      .describe("Horário de entrada em ISO 8601. Omita para entrar agora (ad-hoc)."),
    botName: z
      .string()
      .optional()
      .describe('Nome exibido na call. Default do Recall: "Meeting Notetaker".'),
    dedupKey: z
      .string()
      .optional()
      .describe("Chave de dedup custom. Default: derivada de joinAt+meetingUrl."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    botId: z.string(),
    reused: z.boolean().describe("true se um bot existente foi reusado"),
    scheduled: z.boolean().describe("true=scheduled, false=ad-hoc"),
    dedupKey: z.string(),
  }),
  execute: async (input) => {
    const dedupKey =
      input.dedupKey ?? defaultDedupKey(input.meetingUrl, input.joinAt);

    const existing = await findBotByDedupKey(dedupKey);
    if (existing) {
      return {
        ok: true,
        botId: existing.botId,
        reused: true,
        scheduled: existing.joinAt != null,
        dedupKey,
      };
    }

    // Dono da reunião = usuário da sessão (nunca vem do chat). Necessário para
    // faturar e para o gate de saldo. Persistido na metadata do bot para o
    // webhook/enrich saberem a quem cobrar/notificar.
    const session = await getSession();
    const userId = session?.user?.id ?? null;

    // GATE de saldo: sem crédito suficiente para uma reunião estimada, recusa
    // antes de criar o bot (não gasta recurso do Recall nem gera cobrança).
    if (userId) {
      const ok = await withUserScope(userId, () =>
        hasBalanceForMinutes(userId, ESTIMATED_MEETING_MINUTES),
      );
      if (!ok) {
        throw new Error(
          "Saldo insuficiente para agendar a reunião. Deposite CSPR para adicionar créditos antes de continuar.",
        );
      }
    }

    let bot: RecallBot;
    try {
      bot = await recallFetch<RecallBot>({
        method: "POST",
        path: "v1/bot/",
        body: {
          meeting_url: input.meetingUrl,
          ...(input.joinAt ? { join_at: input.joinAt } : {}),
          ...(input.botName ? { bot_name: input.botName } : {}),
          // Bot entra SEM gravar (start manual). Já deixa transcript configurado
          // para que start_recording capture vídeo + transcrição.
          recording_config: {
            transcript: { provider: { recallai_streaming: {} } },
            participant_events: {},
            start_recording_on: "manual",
          },
          metadata: {
            dedup_key: dedupKey,
            ...(userId ? { user_id: userId } : {}),
          },
        },
      });
    } catch (err) {
      if (err instanceof RecallAdhocPoolError) {
        throw new Error(
          "Pool de bots ad-hoc esgotado (507). Tente novamente em ~30s, ou agende com join_at >10min no futuro.",
        );
      }
      throw err;
    }

    await saveBotMapping({
      dedupKey,
      botId: bot.id,
      meetingUrl: input.meetingUrl,
      joinAt: input.joinAt ? new Date(input.joinAt) : null,
      metadata: userId ? { user_id: userId } : undefined,
    });

    return {
      ok: true,
      botId: bot.id,
      reused: false,
      scheduled: input.joinAt != null,
      dedupKey,
    };
  },
});

/** Consulta o estado atual de um bot. */
export const getRecallBotTool = createTool({
  id: "get_recall_bot",
  description:
    "Consulta o estado atual de um bot do Recall.ai (joining, in_call_recording, done, fatal, etc.) pelo seu ID.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    status: z.string().optional(),
    joinAt: z.string().nullable().optional(),
  }),
  execute: async (input) => {
    const bot = await recallFetch<RecallBot>({
      method: "GET",
      path: `v1/bot/${input.botId}/`,
    });
    return {
      botId: bot.id,
      status: latestStatus(bot),
      joinAt: bot.join_at ?? null,
    };
  },
});

/**
 * Lê a transcrição de um bot após a reunião.
 *
 * O transcript fica em recordings[].media_shortcuts.transcript. Quando pronto
 * (`status=done`), tem um `download_url` para um JSON com as falas — baixamos e
 * montamos um texto legível (participante: fala). Se ainda processando ou se o
 * bot não gravou com transcrição, retorna o estado correspondente.
 */
export const getRecallTranscriptTool = createTool({
  id: "get_recall_transcript",
  description:
    "Lê a transcrição de uma reunião gravada por um bot do Recall.ai, pelo botId. " +
    "Retorna o texto da conversa (por participante) se já estiver pronta. " +
    "Use após a reunião terminar e a gravação processar.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot que gravou a reunião"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    state: z.enum(["ready", "processing", "none"]),
    transcript: z.string().nullable(),
    speakers: z.array(z.string()).optional(),
  }),
  execute: async (input) => {
    const { bot, state, segments } = await loadTranscript(input.botId);
    if (state !== "ready") {
      return { botId: bot.id, state, transcript: null };
    }
    const { text, speakers } = renderTranscript(segments);
    return { botId: bot.id, state, transcript: text, speakers };
  },
});

/** Lista as mídias gravadas de um bot (vídeo/áudio/transcript) e seus estados. */
export const getRecallRecordingTool = createTool({
  id: "get_recall_recording",
  description:
    "Lista as mídias gravadas de um bot do Recall.ai (vídeo, áudio, transcrição) e o estado de cada uma, com link de download quando pronto.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    recordingStatus: z.string().nullable(),
    media: z.array(
      z.object({
        kind: z.string(),
        status: z.string().nullable(),
        downloadUrl: z.string().nullable(),
      }),
    ),
  }),
  execute: async (input) => {
    const bot = await recallFetch<RecallBot>({
      method: "GET",
      path: `v1/bot/${input.botId}/`,
    });
    const rec = bot.recordings?.[0];
    const ms = rec?.media_shortcuts ?? {};

    const media = (["video_mixed", "audio_mixed", "transcript"] as const).map(
      (kind) => {
        const a = ms[kind];
        return {
          kind,
          status: a?.status?.code ?? null,
          downloadUrl: a?.data?.download_url ?? null,
        };
      },
    );

    return {
      botId: bot.id,
      recordingStatus: rec?.status?.code ?? null,
      media,
    };
  },
});

/**
 * Resumo pós-reunião: pega a transcrição e gera resumo + decisões + tarefas.
 *
 * Lê a transcrição do bot (mesma fonte de get_transcript), passa para o LLM via
 * generateObject e devolve estrutura: resumo, decisões, action items (com dono
 * quando mencionado), tópicos. Se a transcrição não estiver pronta, retorna o
 * estado correspondente sem chamar o LLM.
 */
export const summarizeRecallMeetingTool = createTool({
  id: "summarize_recall_meeting",
  description:
    "Gera um resumo da reunião a partir da transcrição de um bot do Recall.ai (pelo botId): " +
    "resumo executivo, decisões tomadas, action items (tarefas com responsável quando citado) e tópicos. " +
    "Use após a reunião terminar e a transcrição estar pronta.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot que gravou a reunião"),
    focus: z
      .string()
      .optional()
      .describe('Foco opcional do resumo, ex: "decisões de produto", "próximos passos".'),
  }),
  outputSchema: z.object({
    botId: z.string(),
    state: z.enum(["ready", "processing", "none"]),
    summary: z.string().nullable(),
    decisions: z.array(z.string()).optional(),
    actionItems: z
      .array(z.object({ task: z.string(), owner: z.string().nullable() }))
      .optional(),
    topics: z.array(z.string()).optional(),
  }),
  // Delega à função server reusável (mesma lógica usada pelo webhook de bot que
  // gera a ata automática no fim da reunião).
  execute: async (input) => summarizeMeeting(input.botId, input.focus),
});

/**
 * Lista participantes e calcula tempo de fala da reunião.
 *
 * Attendance vem do artefato participant_events (participants_download_url).
 * Tempo de fala é derivado da própria transcrição (soma de duração das palavras
 * por participante via timestamps), evitando depender de um segundo artefato.
 */
export const getRecallParticipantsTool = createTool({
  id: "get_recall_participants",
  description:
    "Lista os participantes de uma reunião gravada por um bot do Recall.ai (pelo botId) e o tempo de fala de cada um. " +
    "Use após a reunião para ver quem participou e quem mais falou.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot que gravou a reunião"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    state: z.enum(["ready", "processing", "none"]),
    participants: z
      .array(
        z.object({
          name: z.string(),
          isHost: z.boolean().nullable(),
          speakingSeconds: z.number(),
        }),
      )
      .optional(),
  }),
  execute: async (input) => {
    const bot = await recallFetch<RecallBot>({
      method: "GET",
      path: `v1/bot/${input.botId}/`,
    });

    const pe = bot.recordings?.[0]?.media_shortcuts?.participant_events;
    const peUrl = pe?.data?.participants_download_url;
    if (!pe || pe.status?.code !== "done" || !peUrl) {
      return { botId: bot.id, state: "processing" as const };
    }

    // Attendance: lista de participantes do artefato.
    const peRes = await fetch(peUrl);
    const rawParticipants = (await peRes.json()) as Array<{
      name?: string | null;
      is_host?: boolean | null;
    }>;

    // Tempo de fala derivado da transcrição (duração das palavras por nome).
    const speaking = new Map<string, number>();
    const transcript = bot.recordings?.[0]?.media_shortcuts?.transcript;
    if (transcript?.status?.code === "done" && transcript.data?.download_url) {
      const tRes = await fetch(transcript.data.download_url);
      const segments = (await tRes.json()) as TranscriptSegment[];
      for (const seg of segments) {
        const who = seg.participant?.name ?? "Desconhecido";
        const words = seg.words ?? [];
        const start = words[0]?.start_timestamp?.relative;
        const end = words[words.length - 1]?.end_timestamp?.relative;
        const dur =
          start != null && end != null && end >= start ? end - start : 0;
        speaking.set(who, (speaking.get(who) ?? 0) + dur);
      }
    }

    // Dedup por nome (re-joins criam duplicatas) e junta com speaking time.
    const byName = new Map<string, { isHost: boolean | null }>();
    for (const p of rawParticipants) {
      const name = p.name ?? "Desconhecido";
      if (!byName.has(name)) byName.set(name, { isHost: p.is_host ?? null });
    }
    // Garante quem falou mas não apareceu na lista (raro).
    for (const name of speaking.keys()) {
      if (!byName.has(name)) byName.set(name, { isHost: null });
    }

    const participants = [...byName.entries()]
      .map(([name, v]) => ({
        name,
        isHost: v.isHost,
        speakingSeconds: Math.round(speaking.get(name) ?? 0),
      }))
      .sort((a, b) => b.speakingSeconds - a.speakingSeconds);

    return { botId: bot.id, state: "ready" as const, participants };
  },
});

/** Lista bots agendados para o futuro. */
export const listScheduledRecallBotsTool = createTool({
  id: "list_scheduled_recall_bots",
  description:
    "Lista os bots do Recall.ai agendados para entrar em reuniões a partir de um horário (default: agora).",
  inputSchema: z.object({
    joinAtAfter: z.iso
      .datetime()
      .optional()
      .describe("ISO 8601. Default: agora. Lista bots com join_at após este horário."),
  }),
  outputSchema: z.object({
    count: z.number(),
    bots: z.array(
      z.object({
        botId: z.string(),
        status: z.string().optional(),
        joinAt: z.string().nullable().optional(),
      }),
    ),
  }),
  execute: async (input) => {
    const joinAtAfter = input.joinAtAfter ?? new Date().toISOString();
    const res = await recallFetch<{ count?: number; results?: RecallBot[] }>({
      method: "GET",
      path: "v1/bot/",
      query: { join_at_after: joinAtAfter },
    });
    const bots = (res.results ?? []).map((b) => ({
      botId: b.id,
      status: latestStatus(b),
      joinAt: b.join_at ?? null,
    }));
    return { count: res.count ?? bots.length, bots };
  },
});

/**
 * Cancela/remove um bot.
 * - Scheduled e ainda não entrou (>10min) → DELETE (desagenda).
 * - Já entrando / em call → leave_call (remove da call).
 * O parâmetro `force` força leave_call independente do estado.
 */
export const cancelRecallBotTool = createTool({
  id: "cancel_recall_bot",
  description:
    "Cancela um bot agendado ou remove um bot que já está numa call do Recall.ai. " +
    "Use para desistir de uma reunião ou tirar o bot de uma call em andamento.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot"),
    dedupKey: z
      .string()
      .optional()
      .describe("Se informado, limpa o mapeamento de dedup do app."),
    force: z
      .boolean()
      .optional()
      .describe("true força leave_call (remover da call) em vez de desagendar."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    action: z.enum(["unscheduled", "left_call"]),
  }),
  execute: async (input) => {
    let action: "unscheduled" | "left_call";

    if (input.force) {
      await recallFetch({
        method: "POST",
        path: `v1/bot/${input.botId}/leave_call/`,
      });
      action = "left_call";
    } else {
      // Tenta desagendar; se o bot já entrou (Recall recusa o DELETE), cai p/ leave_call.
      try {
        await recallFetch({ method: "DELETE", path: `v1/bot/${input.botId}/` });
        action = "unscheduled";
      } catch {
        await recallFetch({
          method: "POST",
          path: `v1/bot/${input.botId}/leave_call/`,
        });
        action = "left_call";
      }
    }

    if (input.dedupKey) await deleteBotMapping(input.dedupKey);
    return { ok: true, action };
  },
});

/**
 * Inicia a gravação de um bot que já está na call.
 *
 * O bot deste app entra SEM gravar (start_recording_on padrão não aplicado na
 * criação); a gravação começa quando o usuário pede via chat. Reinicia a
 * gravação atual se já houver uma.
 */
export const startRecallRecordingTool = createTool({
  id: "start_recall_recording",
  description:
    "Inicia a gravação de um bot do Recall.ai que já está na reunião. " +
    "Por padrão captura também a transcrição (Recall.ai Transcription). Reinicia se já estava gravando.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot (deve estar na call)"),
    transcribe: z
      .boolean()
      .optional()
      .describe("Capturar transcrição. Default: true."),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    const transcribe = input.transcribe ?? true;
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/start_recording/`,
      body: transcribe
        ? { transcript: { provider: { recallai_streaming: {} } } }
        : {},
    });
    return { ok: true };
  },
});

/** Para a gravação em andamento de um bot. */
export const stopRecallRecordingTool = createTool({
  id: "stop_recall_recording",
  description:
    "Para a gravação em andamento de um bot do Recall.ai. O bot continua na call.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot"),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/stop_recording/`,
    });
    return { ok: true };
  },
});

/** Pausa a gravação (retomável com resume). */
export const pauseRecallRecordingTool = createTool({
  id: "pause_recall_recording",
  description:
    "Pausa a gravação de um bot do Recall.ai sem encerrá-la. Retome depois com resume_recall_recording.",
  inputSchema: z.object({ botId: z.string().describe("UUID do bot") }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/pause_recording/`,
    });
    return { ok: true };
  },
});

/** Retoma uma gravação pausada. */
export const resumeRecallRecordingTool = createTool({
  id: "resume_recall_recording",
  description: "Retoma uma gravação pausada de um bot do Recall.ai.",
  inputSchema: z.object({ botId: z.string().describe("UUID do bot") }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/resume_recording/`,
    });
    return { ok: true };
  },
});

/** Faz o bot enviar uma mensagem no chat da reunião (Zoom/Meet/Teams). */
export const sendRecallChatMessageTool = createTool({
  id: "send_recall_chat_message",
  description:
    "Faz o bot do Recall.ai enviar uma mensagem no chat da reunião. Suportado em Zoom, Google Meet e Microsoft Teams.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot (deve estar na call)"),
    message: z.string().describe("Texto da mensagem"),
    to: z
      .string()
      .optional()
      .describe('Destinatário. Em plataformas não-Zoom só "everyone" é suportado.'),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/send_chat_message/`,
      body: {
        message: input.message,
        ...(input.to ? { to: input.to } : {}),
      },
    });
    return { ok: true };
  },
});

/** Faz o bot começar a compartilhar tela (output screenshare). */
export const startRecallScreenshareTool = createTool({
  id: "start_recall_screenshare",
  description:
    "Faz o bot do Recall.ai começar a compartilhar tela na reunião. Use stop_recall_screenshare para parar.",
  inputSchema: z.object({ botId: z.string().describe("UUID do bot na call") }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/output_screenshare/`,
    });
    return { ok: true };
  },
});

/** Para o compartilhamento de tela do bot. */
export const stopRecallScreenshareTool = createTool({
  id: "stop_recall_screenshare",
  description: "Para o compartilhamento de tela de um bot do Recall.ai.",
  inputSchema: z.object({ botId: z.string().describe("UUID do bot") }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "DELETE",
      path: `v1/bot/${input.botId}/output_screenshare/`,
    });
    return { ok: true };
  },
});

/**
 * Faz o bot tocar um clipe de áudio na call (output_audio).
 *
 * Para tons/alertas/avisos curtos — NÃO para fala conversacional. Requer bot
 * criado com `automatic_audio_output` habilitado. `b64Data` é mp3 em base64.
 */
export const outputRecallAudioTool = createTool({
  id: "output_recall_audio",
  description:
    "Faz o bot do Recall.ai tocar um clipe de áudio mp3 (base64) na reunião — alertas/tons/avisos curtos. " +
    "Requer bot com automatic_audio_output habilitado.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot na call"),
    b64Data: z.string().describe("Áudio mp3 codificado em base64 (alfabeto padrão)"),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/output_audio/`,
      body: { kind: "mp3", b64_data: input.b64Data },
    });
    return { ok: true };
  },
});

/** Faz o bot exibir uma imagem (jpeg base64) como vídeo na call. */
export const outputRecallVideoTool = createTool({
  id: "output_recall_video",
  description:
    "Faz o bot do Recall.ai exibir uma imagem jpeg (base64, 16:9) como saída de vídeo na reunião.",
  inputSchema: z.object({
    botId: z.string().describe("UUID do bot na call"),
    b64Data: z.string().describe("Imagem jpeg codificada em base64 (16:9)"),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/output_video/`,
      body: { kind: "jpeg", b64_data: input.b64Data },
    });
    return { ok: true };
  },
});
