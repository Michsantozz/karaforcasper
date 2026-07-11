import { Agent } from "@mastra/core/agent";
import { createModel } from "@/mastra/model";
import {
  getRecallTranscriptTool,
  getRecallRecordingTool,
  summarizeRecallMeetingTool,
  getRecallParticipantsTool,
  getMeetingDynamicsTool,
} from "@/mastra/tools/recall.tool";

/**
 * Minutes specialist — a sub-agent of the supervisor (assistantAgent). Owns the
 * "after a meeting" domain: turning a recorded meeting into minutes. It has NO
 * client tools (pick_date/connect_calendar don't reach sub-agents — clientTools
 * are request-scoped to the agent the route invokes), which is exactly why this
 * domain is a clean split: it's all server-side by-botId reads.
 *
 * The supervisor delegates here via its `agents` field; `description` is what
 * the auto-generated delegation tool advertises to the supervisor's model.
 *
 * No memory of its own → it inherits the supervisor's memory (thread + working
 * memory) during delegation, so it sees the same conversation context.
 */
export const minutesAgent = new Agent({
  id: "minutesAgent",
  name: "Minutes Specialist",
  description:
    "Turns a recorded meeting into minutes: summary, decisions, action items, topics (summarize_meeting), participants and speaking time (get_participants), the raw transcript (get_transcript), the recorded media (get_recording), and team-dynamics / meeting-health metrics — who dominated, interruptions, silences, monologues, balance (get_meeting_dynamics). Use for any 'what happened' or 'how did the team interact' request once a botId is known.",
  instructions: `You are the minutes specialist for CasperAgent. Given a meeting (by botId), you produce clear, actionable minutes.

Respond in English.

Tools:
- summarize_meeting → summary + decisions + action items + topics.
- get_participants → list of names + speaking time.
- get_transcript → the raw transcript.
- get_recording → the recorded media, once processing finishes.
- get_meeting_dynamics → team-dynamics / meeting-health metrics: talk-time share per person, interruptions (who cut off whom), silences, monologues, turn-taking, and an overall participation balance (0..1). Use for "how did the team interact", "who dominated", "was it balanced", "any tension" questions.

Rules:
- You always receive the botId in the delegated task. Never ask the user for it.
- Report results in natural language — never dump raw JSON.
- If the recording/transcript isn't ready yet, say so plainly and suggest trying again shortly.`,
  model: () => createModel(),
  tools: {
    summarize_meeting: summarizeRecallMeetingTool,
    get_participants: getRecallParticipantsTool,
    get_transcript: getRecallTranscriptTool,
    get_recording: getRecallRecordingTool,
    get_meeting_dynamics: getMeetingDynamicsTool,
  },
});
