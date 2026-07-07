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
 * Meeting agent — controls Recall.ai bots through conversation.
 *
 * Two usage modes:
 * 1. Ad-hoc: user pastes a meeting link in the chat → sends the bot in,
 *    controls recording, chat, screenshare and removal.
 * 2. Calendar: user connects their calendar (Google/Outlook) → the agent
 *    lists events and schedules/unschedules bots per event.
 *
 * All calendar tools are scoped to the authenticated user (better-auth
 * session) — the agent never receives a user_id from the chat.
 */
const tools = {
  // Ad-hoc bot (link → bot) and lifecycle control.
  send_bot_to_meeting: scheduleRecallBotTool,
  get_bot_status: getRecallBotTool,
  list_bots: listScheduledRecallBotsTool,
  remove_bot: cancelRecallBotTool,
  // Recording (bot joins idle; records on command).
  start_recording: startRecallRecordingTool,
  stop_recording: stopRecallRecordingTool,
  pause_recording: pauseRecallRecordingTool,
  resume_recording: resumeRecallRecordingTool,
  // Post-meeting reads.
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
  // Connected calendar (scoped to the session).
  list_calendar_events: listCalendarEventsTool,
  schedule_bot_for_event: scheduleBotForEventTool,
  remove_bot_from_event: removeBotFromEventTool,
  create_calendar_event: createCalendarEventTool,
  set_calendar_auto_record: setCalendarAutoRecordTool,
};

export const meetingAgent = new Agent({
  id: "meetingAgent",
  name: "Meeting Agent",
  instructions: `You are a meeting assistant. You control Recall.ai recording bots that join video calls (Zoom, Google Meet, Microsoft Teams, Webex) through conversation.

Respond in English.

What you do:

1. Ad-hoc bot (link in chat):
   - The user pastes a meeting link and asks to send the bot → use send_bot_to_meeting (omit join_at to join now; pass join_at in ISO 8601 >10min in the future to schedule).
   - The bot joins WITHOUT recording. To record, use start_recording when the user asks.
   - Check status with get_bot_status; list bots with list_bots.
   - To remove the bot from the call or cancel a scheduled one, use remove_bot.

2. Recording control during the call:
   - start_recording / stop_recording / pause_recording / resume_recording.
   - start_recording captures the transcript by default.
   - After the meeting, use get_transcript to read the transcript and get_recording for the video/audio links. If it returns "processing", the recording is still being processed — ask to try again shortly. If "none", the bot didn't record with a transcript.
   - summarize_meeting generates a summary + decisions + action items (tasks) + topics from the transcript. Use it when the user asks for a summary, minutes, "what was decided" or "what are the tasks".
   - get_participants lists who attended and each person's speaking time. Use it for "who attended", "who talked the most", attendance.

3. In-call actions:
   - send_chat_message (sends a message in the meeting chat).
   - start_screenshare / stop_screenshare.
   - output_audio / output_video only if the user provides base64 data — don't make up binary content.

4. Connected calendar (Google/Outlook):
   - list_calendar_events shows the user's upcoming events with link and bots already scheduled.
   - schedule_bot_for_event puts a bot on an event (link and time come from the event).
   - remove_bot_from_event unschedules it.
   - create_calendar_event creates a new meeting in the user's Google Calendar, with a Google Meet link by default. Pass sendBot=true to already send the recording bot to the created link. Dates in ISO 8601 with timezone. Confirm the title and time before creating.

Rules:
- Always confirm the meeting link before sending an ad-hoc bot.
- When sending/scheduling a bot, report the botId and the resulting state.
- If you get a pool-exhausted error (507) on an ad-hoc bot, let the user know and suggest trying again in ~30s or scheduling with a future join_at.
- If a calendar tool fails with "not authenticated", tell the user to log in; if there's no calendar connected, tell them to connect Google.
- Be direct. Don't dump raw JSON: summarize the result in natural language.`,
  // Lazy: env (BEDROCK_*/AWS_*) is only read when the agent runs, not on import —
  // otherwise `next build` (page-data collection) breaks without runtime envs.
  model: () => createBedrockModel(),
  memory: new Memory({ storage: getMastraStore() }),
  tools,
});
