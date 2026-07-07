import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Reconciliação de atas de reunião (sem humano no loop).
 *
 * O caminho feliz gera a ata no webhook de bot (transcript.done). Este cron é a
 * REDE DE SEGURANÇA: se o webhook se perdeu, chegou antes da transcrição ficar
 * pronta, ou o enrichment falhou transitoriamente, a linha em meeting_records
 * fica "pending"/"processing". Aqui varremos as presas e reprocessamos — durável
 * por construção (cada tick é uma nova tentativa).
 *
 * Roda a cada 5 min. staleMs=5min: só toca linhas paradas há tempo suficiente,
 * evitando corrida com o enrichment disparado pelo webhook.
 */
const reconcile = createStep({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  execute: async () => {
    const { reconcileStuckMeetings } = await import("@/server/recall/enrich");
    return reconcileStuckMeetings(5 * 60_000);
  },
});

export const meetingReconcileWorkflow = createWorkflow({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  cron: "*/5 * * * *",
}).then(reconcile);

meetingReconcileWorkflow.commit();
