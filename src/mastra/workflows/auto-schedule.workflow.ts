import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Auto-scheduling de bots por agenda (sem humano no loop).
 *
 * O caminho reativo agenda via webhook calendar.sync_events. Este cron é a REDE
 * DE SEGURANÇA: varre todos os calendars com gravação automática ligada (opt-in)
 * e agenda bots nos próximos eventos com meeting_url — cobrindo webhooks perdidos
 * e eventos criados fora de uma janela de sync. Idempotente (dedup por evento no
 * Recall), então rodar de novo não duplica bots.
 *
 * Roda a cada 10 min.
 */
const scan = createStep({
  id: "auto-schedule",
  inputSchema: z.object({}),
  outputSchema: z.object({
    calendars: z.number(),
    scheduled: z.number(),
  }),
  execute: async () => {
    const { autoScheduleAll } = await import("@/server/recall/auto-schedule");
    return autoScheduleAll();
  },
});

export const autoScheduleWorkflow = createWorkflow({
  id: "auto-schedule",
  inputSchema: z.object({}),
  outputSchema: z.object({
    calendars: z.number(),
    scheduled: z.number(),
  }),
  cron: "*/10 * * * *",
}).then(scan);

autoScheduleWorkflow.commit();
