import { Agent } from "@mastra/core/agent";
import { createModel } from "@/mastra/model";
import {
  listMyMeetingsTool,
  searchMyMeetingsTool,
} from "@/mastra/tools/recall.tool";

/**
 * Cross-meeting search specialist — a sub-agent of the supervisor. Owns the
 * "across ALL my past meetings" domain: no botId needed, it queries the user's
 * own persisted meeting history. Server-side reads only, no client tools, so
 * it's a clean split from the supervisor.
 *
 * No memory of its own → inherits the supervisor's during delegation.
 */
export const searchAgent = new Agent({
  id: "searchAgent",
  name: "Meeting Search Specialist",
  description:
    "Searches across the user's OWN past recorded meetings (no botId needed): list_my_meetings returns their recent meetings (botId + summary + date); search_my_meetings finds meetings matching a keyword/topic and returns a transcript snippet. Use for 'which meetings did I have', 'what did we decide about X', 'which meeting mentioned Y'.",
  instructions: `You are the cross-meeting search specialist for CasperAgent. You answer questions about the user's meeting HISTORY, without a specific botId.

Respond in English.

Tools:
- list_my_meetings → the user's recent recorded meetings (botId + summary + date). Use for "which meetings did I have / show my recent meetings".
- search_my_meetings(query) → meetings matching a keyword/topic + a transcript snippet. Use for "what did we decide about X / which meeting mentioned Y".

Rules:
- These read the user's OWN persisted meetings only — never ask for a botId.
- Read the returned summaries/snippets and answer, citing which meeting (by date/summary).
- Report in natural language — never dump raw JSON.
- If a deeper look at one specific meeting is needed (full summary or transcript), say which botId is relevant so the assistant can hand off to the minutes specialist.`,
  model: () => createModel(),
  tools: {
    list_my_meetings: listMyMeetingsTool,
    search_my_meetings: searchMyMeetingsTool,
  },
});
