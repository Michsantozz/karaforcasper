import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import {
  TokenLimiter,
  CostGuardProcessor,
  PromptInjectionDetector,
  PIIDetector,
  type InputProcessor,
  type OutputProcessor,
} from "@mastra/core/processors";
import { createModel, createEmbedder } from "@/mastra/model";
import { getMastraStore, getMastraVector } from "@/mastra/storage";
import { mcp } from "@/mastra/mcp";
import { minutesAgent } from "@/mastra/agents/minutes.agent";
import { searchAgent } from "@/mastra/agents/search.agent";
import {
  scheduleRecallBotTool,
  getRecallBotTool,
  listScheduledRecallBotsTool,
  cancelRecallBotTool,
  startRecallRecordingTool,
  stopRecallRecordingTool,
} from "@/mastra/tools/recall.tool";
import {
  listCalendarEventsTool,
  scheduleBotForEventTool,
  removeBotFromEventTool,
  createCalendarEventTool,
  getFreeSlotsTool,
} from "@/mastra/tools/calendar.tool";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("mcp");

/**
 * CasperAgent's meeting assistant — brings together meetings (Recall.ai) and
 * the connected calendar (Google/Outlook). It schedules recording bots, records,
 * transcribes, summarizes, and turns meetings into actionable minutes.
 *
 * The pick_date tool is a FRONTEND tool — registered on the client
 * (PickDateToolUI) and injected into the request; here we only declare the
 * server-side ones. clientTools arrive via route.
 */
// Supervisor's OWN tools — scheduling, calendar and live bot-control. These stay
// on the supervisor (not a sub-agent) because the scheduling flow depends on the
// pick_date / connect_calendar CLIENT tools, and clientTools are request-scoped
// to the invoked agent — they don't reach sub-agents. The "minutes" and
// "cross-meeting search" domains have no client tools, so they live in
// minutesAgent / searchAgent and the supervisor delegates to them.
const localTools = {
  // --- Meetings (Recall.ai): scheduling + live bot control ---
  send_bot_to_meeting: scheduleRecallBotTool,
  get_bot_status: getRecallBotTool,
  list_bots: listScheduledRecallBotsTool,
  remove_bot: cancelRecallBotTool,
  start_recording: startRecallRecordingTool,
  stop_recording: stopRecallRecordingTool,

  // --- Connected calendar ---
  list_calendar_events: listCalendarEventsTool,
  schedule_bot_for_event: scheduleBotForEventTool,
  remove_bot_from_event: removeBotFromEventTool,
  create_calendar_event: createCalendarEventTool,
  get_free_slots: getFreeSlotsTool,
};

/**
 * Guardrails / cost control (input side). The chat is public-facing and spends
 * real LLM tokens (Fireworks/Bedrock), so we cap cost and defend the prompt:
 *
 *  - CostGuardProcessor (always on): per-user ceiling. `scope:'resource'` tracks
 *    cumulative spend per user over a window and blocks once it exceeds maxCost.
 *    Reads from the observability metrics we now export — zero extra LLM cost.
 *  - PromptInjectionDetector + PIIDetector (LLM-based → extra latency+cost):
 *    gated behind ENABLE_LLM_GUARDRAILS. When on, injection is BLOCKED and PII is
 *    REDACTED before the message reaches the model. `lastMessageOnly` keeps the
 *    check cheap (only the newest user turn, not the whole history). They reuse
 *    the agent's own model so no second provider is needed.
 *
 * Lazy (DynamicArgument): built per request so envs are read at runtime, not at
 * import — same reason `model` is lazy (keeps `next build` working env-free).
 */
const MAX_COST_PER_USER = Number(process.env.MAX_COST_PER_USER_USD ?? "1.0");

function buildInputProcessors(): InputProcessor[] {
  const processors: InputProcessor[] = [];
  // DISABLE_COST_GUARD is a temporary escape hatch to isolate whether the
  // CostGuard tripwire is silently blocking generation (start→finish, no text).
  if (process.env.DISABLE_COST_GUARD !== "true") {
    processors.push(
      new CostGuardProcessor({
        maxCost: MAX_COST_PER_USER,
        scope: "resource",
        window: "24h",
        strategy: "block",
      }),
    );
  }
  if (process.env.ENABLE_LLM_GUARDRAILS === "true") {
    const model = createModel();
    processors.push(
      new PromptInjectionDetector({
        model,
        strategy: "block",
        lastMessageOnly: true,
      }),
      new PIIDetector({
        model,
        strategy: "redact",
        redactionMethod: "placeholder",
        lastMessageOnly: true,
      }),
    );
  }
  return processors;
}

/**
 * Output side: cap the GENERATED response so a runaway generation can't burn
 * tokens unbounded. Non-LLM, cheap. 'truncate' stops emitting past the limit.
 *
 * countMode:"part" is REQUIRED here: the default 'cumulative' counts tokens from
 * the start of the stream, which includes the prompt echoed through the pipeline
 * (system prompt + tool schemas + memory ≈ thousands of tokens). With a large
 * agent that overflows the 4000-token limit BEFORE the first output token, so
 * truncate emits an empty response. "part" counts only the current output part,
 * which is what "cap the generated response" actually means.
 */
function buildOutputProcessors(): OutputProcessor[] {
  return [
    new TokenLimiter({
      limit: Number(process.env.MAX_RESPONSE_TOKENS ?? "4000"),
      strategy: "truncate",
      countMode: "part",
    }),
  ];
}

export const assistantAgent = new Agent({
  id: "assistantAgent",
  name: "Casper Assistant",
  instructions: `You are the CasperAgent assistant: you help users run their meetings. You schedule recording bots, capture what happens, and turn meetings into clear, actionable minutes.

Respond in English.

You are the SUPERVISOR. You handle scheduling, calendar and live bot control yourself, and you DELEGATE two domains to specialists:
- minutesAgent — anything about ONE specific meeting once a botId is known: summary/decisions/action items/topics, participants + speaking time, transcript, recorded media.
- searchAgent — anything across the user's meeting HISTORY without a botId: list their meetings, find meetings by keyword/topic.
When a request falls into one of those, delegate to the specialist rather than answering yourself. Then relay the specialist's result to the user in natural language.

Capabilities you own directly:
- Meetings (Recall.ai): send/schedule recording bots, live control (start/stop recording, remove bot).
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

1) After a meeting (minutes) → DELEGATE to minutesAgent:
   - Any "summarize this meeting / who spoke most / what were the decisions / show the transcript" request, once you have the botId (from context, or from searchAgent), goes to minutesAgent. Pass it the botId and what the user asked. Relay its answer.

1b) Cross-meeting questions (meeting history, no botId given) → DELEGATE to searchAgent:
   - "Which meetings did I have / show my recent meetings", "what did we decide about X / which meeting mentioned Y" → searchAgent. It reads the user's OWN meetings, so never ask for a botId.
   - If the user then wants full detail on ONE of those hits, take its botId and delegate to minutesAgent.

2) During a live meeting:
   - Control the bot's recording: start_recording / stop_recording.
   - Remove the bot from the call with remove_bot.

3) Sharing a meeting's minutes by email:
   - When the user asks to send/share/email a meeting's summary to SOMEONE (any recipient — e.g. their manager, a client, a teammate who missed it), call confirm_send_summary_email. This shows a confirmation card with the recipient + an optional note and a Send button — the email is only sent when the USER clicks Send. NEVER send silently, and never treat this as a background action.
   - Pass botId (the meeting to share). Resolve it first: from the open meeting context, from a botId the user already referenced, or via searchAgent if they described the meeting ("the sales call yesterday"). If you can't identify which meeting, ask which one before calling the tool.
   - If the user named a recipient, pass 'to' (their email). If they dictated a message, pass 'note'. If they didn't give an email, still call the tool with just botId — the user fills in the recipient on the card.
   - confirm_send_summary_email returns { sent, to }. If sent:true, confirm to the user that the minutes were emailed to that address. If sent:false with error "cancelled", the user declined — do NOT retry or resend; just acknowledge.

Working memory (durable user profile):
- You keep a per-user profile (name, timezone, default meeting duration, recording preference, calendar connection, usual meeting times). It persists across ALL of this user's conversations.
- Whenever the user reveals a durable fact — their timezone, that they prefer 30-min meetings, that their calendar is connected, that they never record 1:1s — UPDATE the working memory so you don't ask again next time.
- READ it before asking: if the timezone/duration is already there, use it silently instead of asking. Don't ask for something you already know.

General rules:
- Don't dump raw JSON: summarize in natural language.
- If a user tool returns cancelled, don't proceed — explain and offer to try again.`,
  // Lazy: model envs (MODEL_PROVIDER / FIREWORKS_* / BEDROCK_*) are only read
  // when the agent runs, not on import — otherwise `next build` (page-data
  // collection) breaks without runtime envs. Defaults to Fireworks (Track 3).
  model: () => createModel(),
  // Persistent memory in PG (schema `mastra`). Four features on:
  //  - generateTitle: the agent names each thread from the first user message
  //    and persists it via updateThread, so the sidebar shows real titles
  //    instead of "New Chat" (runs async, doesn't slow the response).
  //  - workingMemory (resource-scoped): a durable per-user profile the agent
  //    reads/writes across ALL their threads — timezone, recording prefs,
  //    default meeting duration, whether their calendar is connected. This is
  //    what lets "schedule at my usual time" or "in my timezone" work without
  //    the user restating it every conversation.
  //  - semanticRecall (resource-scoped): past messages are embedded (Fireworks
  //    Qwen3-Embedding-8B) into pgvector and retrieved by MEANING, not just the
  //    last 20. So "what did we decide about the budget?" pulls the relevant
  //    turn back even from an old conversation. topK=5 + messageRange gives the
  //    matched message plus surrounding context.
  // Lazy (DynamicArgument): createEmbedder() reads FIREWORKS_API_KEY via
  // requireEnv, which THROWS if absent. Building it here (per request) instead of
  // at import keeps `next build` working env-free — same reason model/tools are
  // lazy. Memory instances are cheap; storage/vector are singletons underneath.
  memory: () =>
    new Memory({
      storage: getMastraStore(),
      vector: getMastraVector(),
      embedder: createEmbedder(),
      options: {
        lastMessages: 20,
        generateTitle: true,
        semanticRecall: {
          topK: 5,
          messageRange: 2,
          scope: "resource",
        },
        workingMemory: {
          enabled: true,
          scope: "resource",
          template: `# User Profile
- **Name**:
- **Timezone**: (e.g. America/Sao_Paulo / BRT -03:00)
- **Default meeting duration**: (e.g. 30m, 1h)
- **Recording preference**: (bot on by default? any meetings to skip?)
- **Calendar**: (connected? Google/Outlook? primary email)
- **Usual meeting times / working hours**:
- **Other preferences**:`,
        },
      },
    }),
  // DynamicArgument: combines local tools + MCP tools (Recall.ai read-only).
  tools: async () => {
    const { toolsets, errors } = await mcp.listToolsetsWithErrors();
    for (const [server, err] of Object.entries(errors)) {
      log.error({ server, err }, "MCP server unavailable");
    }
    const mcpTools = Object.values(toolsets).reduce(
      (acc, serverTools) => Object.assign(acc, serverTools),
      {},
    );
    // localTools win name collisions with the MCP. The Recall MCP exposes its
    // own `list_calendar_events` (raw snake_case payload, NO event title, plus a
    // per-event get_calendar_event) — if it spread last it would shadow our
    // curated `listCalendarEventsTool`, which is user-scoped and already returns
    // each event's `title` from the list. That shadowing is exactly what made
    // the agent fire one get_calendar_event per event just to learn titles. MCP
    // tools only FILL GAPS (read-only helpers we don't wrap); ours take priority.
    return { ...mcpTools, ...localTools };
  },
  // Sub-agents: Mastra auto-generates a delegation tool per entry (using each
  // agent's `description`). The supervisor's model decides when to hand off. Both
  // inherit this agent's memory during delegation (they have none of their own).
  agents: { minutesAgent, searchAgent },
  // Cost ceiling + optional prompt-injection/PII guardrails (input), response
  // token cap (output). Lazy so envs resolve at request time. See builders above.
  inputProcessors: () => buildInputProcessors(),
  outputProcessors: () => buildOutputProcessors(),
});
