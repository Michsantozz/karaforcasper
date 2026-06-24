import { createServe } from "@mastra/inngest";
import { serve } from "inngest/next";
import { mastra } from "@/mastra";
import { inngest } from "@/inngest/client";

// Endpoint que o inngest-cli descobre (pnpm dev:inngest -u .../api/inngest).
// Expõe o autonomous-loop com seu cron — é o que torna o agente AUTÔNOMO.
const serveNext = createServe(serve);

export const { GET, POST, PUT } = serveNext({ mastra, inngest });
