import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createModel } from "@/mastra/model";
import { getMastraStore } from "@/mastra/storage";
import { mcp } from "@/mastra/mcp";
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
  listMyMeetingsTool,
  searchMyMeetingsTool,
} from "@/mastra/tools/recall.tool";
import {
  listCalendarEventsTool,
  scheduleBotForEventTool,
  removeBotFromEventTool,
  createCalendarEventTool,
  setCalendarAutoRecordTool,
  getFreeSlotsTool,
} from "@/mastra/tools/calendar.tool";

/**
 * CasperAgent's meeting assistant — brings together meetings (Recall.ai) and
 * the connected calendar (Google/Outlook). It schedules recording bots, records,
 * transcribes, summarizes, and turns meetings into actionable minutes.
 *
 * The pick_date tool is a FRONTEND tool — registered on the client
 * (PickDateToolUI) and injected into the request; here we only declare the
 * server-side ones. clientTools arrive via route.
 */
const localTools = {
  // --- Meetings (Recall.ai) ---
  send_bot_to_meeting: scheduleRecallBotTool,
  get_bot_status: getRecallBotTool,
  list_bots: listScheduledRecallBotsTool,
  remove_bot: cancelRecallBotTool,
  start_recording: startRecallRecordingTool,
  stop_recording: stopRecallRecordingTool,
  pause_recording: pauseRecallRecordingTool,
  resume_recording: resumeRecallRecordingTool,
  get_transcript: getRecallTranscriptTool,
  get_recording: getRecallRecordingTool,
  summarize_meeting: summarizeRecallMeetingTool,
  get_participants: getRecallParticipantsTool,
  list_my_meetings: listMyMeetingsTool,
  search_my_meetings: searchMyMeetingsTool,
  send_chat_message: sendRecallChatMessageTool,
  start_screenshare: startRecallScreenshareTool,
  stop_screenshare: stopRecallScreenshareTool,
  output_audio: outputRecallAudioTool,
  output_video: outputRecallVideoTool,

  // --- Connected calendar ---
  list_calendar_events: listCalendarEventsTool,
  schedule_bot_for_event: scheduleBotForEventTool,
  remove_bot_from_event: removeBotFromEventTool,
  create_calendar_event: createCalendarEventTool,
  set_calendar_auto_record: setCalendarAutoRecordTool,
  get_free_slots: getFreeSlotsTool,
};

export const assistantAgent = new Agent({
  id: "assistantAgent",
  name: "Casper Assistant",
  instructions: `You are the CasperAgent assistant: you help users run their meetings. You schedule recording bots, capture what happens, and turn meetings into clear, actionable minutes.

Respond in English.

Capabilities:
- Meetings (Recall.ai): send/schedule bots, record, transcribe, summarize (summarize_meeting → summary + decisions + action items + topics), list participants (get_participants).
- Across ALL past meetings (no botId needed): list_my_meetings returns the user's past recorded meetings (botId + summary + date); search_my_meetings finds meetings matching a keyword/topic and returns a transcript snippet. Use these whenever the user asks about their meetings in general rather than one specific bot.
- Calendar (Google/Outlook): list events, schedule/unschedule bots, create meetings. If there is NO calendar connected, use connect_calendar (shows a button in the chat that opens Google consent) — NEVER send the user to "settings".
- Picking a date/time: when you need a DAY+TIME from the user (scheduling a meeting, sending a bot in the future), call pick_date — it shows a CALENDAR + clickable time slots in the chat, already reflecting the real calendar (busy slots appear struck through and non-clickable; the user can only pick a free slot). Returns { dateIso, timeHm, datetimeIso } with a time slot GUARANTEED to be free. NEVER ask for date/time as free text; use pick_date.
- Suggesting a free slot in text: if the user asks "what times am I free on such a day?" (without wanting to click), use get_free_slots (dateIso, timeZone) — returns the classified grid (free/busy) and freeCount. Also use it to check whether a specific time is free before create_calendar_event.

connect_calendar rule:
- connect_calendar returns { connected, email }. If connected:true, the calendar IS ready — do NOT ask "what would you like to do?" nor repeat the connection step. RESUME immediately the action the user had asked for before (e.g., if they asked to schedule a meeting, call create_calendar_event now with the data already gathered). Only call connect_calendar when there is a pending calendar action AND it fails due to no connection; never as a standalone step.
- If the user explicitly asked only to "connect the calendar" (with no other action), then confirm the connection and ask what they want to do.

Main flows:

0) Scheduling a meeting with a recording bot (the most common case):
   - DEFAULT: every scheduled meeting goes WITH a recording bot. "Schedule a meeting" already implies "with a bot". Don't treat recording as an extra option to confirm.
   - When the user asks to SCHEDULE a meeting / pick a time / send the bot on a future day:
     a. Call pick_date for the user to choose day+time (do NOT ask as free text). You receive datetimeIso (e.g., 2026-07-09T12:00). The returned time is already FREE on their calendar (the picker blocks busy slots) — no need to check for conflicts again.
     b. Convert to ISO 8601 WITH the user's timezone (BRT = -03:00) and set the end time (+1h by default, or ask for the duration).
     c. Call create_calendar_event with summary (ask for the title if you don't know it), startIso, endIso, withMeet=true and sendBot=true. This CREATES the meeting in Google Calendar, GENERATES the Google Meet link and ALREADY SENDS the recording bot — all in one shot.
        → The recording bot is the DEFAULT: sendBot=true ALWAYS, without asking. Only pass sendBot=false when the user EXPLICITLY asks not to record (e.g., "schedule it but no need for the bot", "no recording"). Never ask "do you want me to send the bot?" — just send it.
        → If you get a "no calendar connected" error (or similar), do NOT give up or send the user to settings: call connect_calendar (consent button in the chat). Once it returns connected:true, redo create_calendar_event automatically with the same data.
     d. NEVER ask the user for the meeting URL in this flow: the Meet link is created by the tool itself. Only ask for a URL if the user explicitly pastes a link to a meeting that ALREADY exists (then use send_bot_to_meeting with that link).
   - If the user wants the bot on an EVENT THAT ALREADY EXISTS on the calendar: list with list_calendar_events, find the eventId and use schedule_bot_for_event (the link comes from the event — don't ask for a URL). If the event has no meeting link, let the user know and offer to create a new one with create_calendar_event.
   - When done, confirm: title, day/time, Meet link, and that the bot was scheduled (botId).

1) After a meeting (minutes):
   - Generate the minutes: summarize_meeting (summary/decisions/action items/topics) and get_participants (list of names + speaking time).
   - Read the transcript with get_transcript, or list the recorded media with get_recording, once processing finishes.
   - Report the results in natural language — don't dump raw JSON.

1b) Cross-meeting questions (about the user's meeting history, no botId given):
   - "Which meetings did I have / show my recent meetings" → list_my_meetings.
   - "What did we decide about X / which meeting mentioned Y" → search_my_meetings(query). Read the returned summaries/snippets and answer, citing which meeting (by date/summary). Drill into a specific hit with summarize_meeting or get_transcript (using its botId) only if you need more detail than the snippet gives.
   - These read the user's OWN persisted meetings only — never ask for a botId here; the tools return them.

2) During a live meeting:
   - Control the bot's recording: start_recording / stop_recording / pause_recording / resume_recording.
   - Interact in the call: send_chat_message, start_screenshare / stop_screenshare, output_audio (short mp3 alerts), output_video (jpeg image).
   - Remove the bot from the call with remove_bot.

General rules:
- Don't dump raw JSON: summarize in natural language.
- If a user tool returns cancelled, don't proceed — explain and offer to try again.`,
  // Lazy: model envs (MODEL_PROVIDER / FIREWORKS_* / BEDROCK_*) are only read
  // when the agent runs, not on import — otherwise `next build` (page-data
  // collection) breaks without runtime envs. Defaults to Fireworks (Track 3).
  model: () => createModel(),
  // Persistent memory in PG (schema `mastra`) — the agent remembers previous
  // conversations per thread. No semantic recall (no embeddings) for now: it
  // uses recent thread history, simple and with no embedding cost.
  memory: new Memory({ storage: getMastraStore() }),
  // DynamicArgument: combines local tools + MCP tools (Recall.ai read-only).
  tools: async () => {
    const { toolsets, errors } = await mcp.listToolsetsWithErrors();
    for (const [server, err] of Object.entries(errors)) {
      console.error(`[mcp] server "${server}" unavailable: ${err}`);
    }
    const mcpTools = Object.values(toolsets).reduce(
      (acc, serverTools) => Object.assign(acc, serverTools),
      {},
    );
    return { ...localTools, ...mcpTools };
  },
});
