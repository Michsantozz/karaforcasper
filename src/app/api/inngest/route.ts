import { createServe } from "@mastra/inngest";
import { serve } from "inngest/next";
import { mastra } from "@/mastra";
import { inngest } from "@/inngest/client";

// Endpoint discovered by inngest-cli (pnpm dev:inngest -u .../api/inngest).
// Exposes the autonomous-loop with its cron — this is what makes the agent AUTONOMOUS.
const serveNext = createServe(serve);

export const { GET, POST, PUT } = serveNext({ mastra, inngest });
