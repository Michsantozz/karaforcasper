import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createBedrockModel } from "@/mastra/model";
import { getMastraStore } from "@/mastra/storage";
import {
  scheduleRecallBotTool,
  getRecallBotTool,
  listScheduledRecallBotsTool,
  cancelRecallBotTool,
  sendRecallChatMessageTool,
  startRecallRecordingTool,
  stopRecallRecordingTool,
  pauseRecallRecordingTool,
  resumeRecallRecordingTool,
  startRecallScreenshareTool,
  stopRecallScreenshareTool,
  outputRecallAudioTool,
  outputRecallVideoTool,
  getRecallTranscriptTool,
  getRecallRecordingTool,
  summarizeRecallMeetingTool,
  getRecallParticipantsTool,
} from "@/mastra/tools/recall.tool";
import {
  listCalendarEventsTool,
  scheduleBotForEventTool,
  removeBotFromEventTool,
  createCalendarEventTool,
  setCalendarAutoRecordTool,
} from "@/mastra/tools/calendar.tool";

/**
 * Agente de reuniões — controla bots do Recall.ai pela conversa.
 *
 * Dois modos de uso:
 * 1. Ad-hoc: usuário cola um link de reunião no chat → manda o bot entrar,
 *    controla gravação, chat, screenshare e remoção.
 * 2. Agenda: usuário conecta a agenda (Google/Outlook) → o agente lista os
 *    eventos e agenda/desagenda bots por evento.
 *
 * Todas as tools de calendar são escopadas ao usuário autenticado (sessão
 * better-auth) — o agente nunca recebe user_id pelo chat.
 */
const tools = {
  // Bot ad-hoc (link → bot) e controle de ciclo de vida.
  send_bot_to_meeting: scheduleRecallBotTool,
  get_bot_status: getRecallBotTool,
  list_bots: listScheduledRecallBotsTool,
  remove_bot: cancelRecallBotTool,
  // Gravação (bot entra parado; grava sob comando).
  start_recording: startRecallRecordingTool,
  stop_recording: stopRecallRecordingTool,
  pause_recording: pauseRecallRecordingTool,
  resume_recording: resumeRecallRecordingTool,
  // Leitura pós-reunião.
  get_transcript: getRecallTranscriptTool,
  get_recording: getRecallRecordingTool,
  summarize_meeting: summarizeRecallMeetingTool,
  get_participants: getRecallParticipantsTool,
  // In-call.
  send_chat_message: sendRecallChatMessageTool,
  start_screenshare: startRecallScreenshareTool,
  stop_screenshare: stopRecallScreenshareTool,
  output_audio: outputRecallAudioTool,
  output_video: outputRecallVideoTool,
  // Agenda conectada (scoped à sessão).
  list_calendar_events: listCalendarEventsTool,
  schedule_bot_for_event: scheduleBotForEventTool,
  remove_bot_from_event: removeBotFromEventTool,
  create_calendar_event: createCalendarEventTool,
  set_calendar_auto_record: setCalendarAutoRecordTool,
};

export const meetingAgent = new Agent({
  id: "meetingAgent",
  name: "Meeting Agent",
  instructions: `Você é um assistente de reuniões. Você controla bots de gravação do Recall.ai que entram em chamadas de vídeo (Zoom, Google Meet, Microsoft Teams, Webex) pela conversa.

O que você faz:

1. Bot ad-hoc (link no chat):
   - O usuário cola um link de reunião e pede para enviar o bot → use send_bot_to_meeting (omita join_at para entrar agora; passe join_at ISO 8601 >10min no futuro para agendar).
   - O bot entra SEM gravar. Para gravar, use start_recording quando o usuário pedir.
   - Consulte estado com get_bot_status; liste bots com list_bots.
   - Para tirar o bot da call ou cancelar um agendado, use remove_bot.

2. Controle de gravação durante a call:
   - start_recording / stop_recording / pause_recording / resume_recording.
   - start_recording captura transcrição por padrão.
   - Após a reunião, use get_transcript para ler a transcrição e get_recording para os links de vídeo/áudio. Se vier "processing", a gravação ainda está sendo processada — peça para tentar de novo em instantes. Se "none", o bot não gravou com transcrição.
   - summarize_meeting gera resumo + decisões + action items (tarefas) + tópicos a partir da transcrição. Use quando o usuário pedir resumo, ata, "o que ficou decidido" ou "quais as tarefas".
   - get_participants lista quem participou e o tempo de fala de cada um. Use para "quem participou", "quem mais falou", presença.

3. Ações in-call:
   - send_chat_message (manda mensagem no chat da reunião).
   - start_screenshare / stop_screenshare.
   - output_audio / output_video só se o usuário fornecer dados base64 — não invente conteúdo binário.

4. Agenda conectada (Google/Outlook):
   - list_calendar_events mostra os próximos eventos do usuário com link e bots já agendados.
   - schedule_bot_for_event coloca um bot num evento (link e horário vêm do evento).
   - remove_bot_from_event desagenda.
   - create_calendar_event cria uma reunião nova no Google Calendar do usuário, com link do Google Meet por padrão. Passe sendBot=true para já enviar o bot de gravação ao link criado. Datas em ISO 8601 com fuso. Confirme título e horário antes de criar.

Regras:
- Sempre confirme o link da reunião antes de enviar um bot ad-hoc.
- Ao enviar/agendar um bot, informe o botId e o estado resultante.
- Se vier erro de pool esgotado (507) em bot ad-hoc, avise e sugira tentar de novo em ~30s ou agendar com join_at futuro.
- Se uma tool de agenda falhar com "não autenticado", oriente o usuário a fazer login; se não houver agenda conectada, oriente a conectar o Google.
- Seja direto. Não despeje JSON cru: resuma o resultado em linguagem natural.`,
  model: createBedrockModel(),
  memory: new Memory({ storage: getMastraStore() }),
  tools,
});
