import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

// Loop autônomo genérico do agente — percebe → decide → age, sem humano no loop.
// Este é o componente AGÊNTICO exigido pelo buildathon: o agente roda em schedule,
// avalia o estado on-chain e decide sozinho se executa transação.
//
// É genérico de propósito: a política de decisão vive no prompt do agente, então
// serve qualquer ideia (yield-routing, RWA oracle, treasury, KYC...). Trocar a
// estratégia = trocar instruções, não o wire.

// 1. PERCEBER — lê o estado atual do agente on-chain (saldo + endereço).
const perceive = createStep({
  id: "perceive",
  inputSchema: z.object({}),
  outputSchema: z.object({
    publicKey: z.string(),
    balanceCspr: z.string(),
  }),
  execute: async ({ mastra }) => {
    const agent = mastra!.getAgent("casperAgent");
    const res = await agent.generate(
      "Consulte a carteira do agente e retorne APENAS o estado atual (endereço e saldo). Não execute transações nesta etapa.",
    );
    // O texto é informativo; o estado canônico vem das tools chamadas.
    // Lemos direto da chain para ter dados confiáveis (sem depender do parse do LLM).
    const { getAgentPublicKeyHex } = await import("@/lib/casper/client");
    const { getBalanceCspr } = await import("@/lib/casper/transfer");
    const publicKey = await getAgentPublicKeyHex();
    const balanceCspr = await getBalanceCspr(publicKey).catch(() => "0");
    void res;
    return { publicKey, balanceCspr };
  },
});

// 2. DECIDIR + AGIR — o LLM avalia o estado e decide autonomamente se age.
//    Se decidir agir, chama as tools (transfer_cspr) e gera tx real on-chain.
const decideAndAct = createStep({
  id: "decide-and-act",
  inputSchema: z.object({
    publicKey: z.string(),
    balanceCspr: z.string(),
  }),
  outputSchema: z.object({
    decision: z.string(),
    acted: z.boolean(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra!.getAgent("casperAgent");
    const response = await agent.generate(
      [
        {
          role: "user",
          content: [
            "Você está rodando em modo autônomo (sem humano no loop).",
            `Estado atual: endereço=${inputData.publicKey} saldo=${inputData.balanceCspr} CSPR.`,
            "Avalie segundo sua política operacional e DECIDA sozinho se deve executar alguma ação on-chain.",
            "Se decidir agir, execute a transação via as tools disponíveis.",
            "Responda em 1-2 frases: qual decisão tomou e por quê.",
          ].join(" "),
        },
      ],
    );
    const text = response.text ?? "";
    const acted = /transactionHash|tx |transação|transfer/i.test(text);
    return { decision: text, acted };
  },
});

export const autonomousWorkflow = createWorkflow({
  id: "autonomous-loop",
  inputSchema: z.object({}),
  outputSchema: z.object({
    decision: z.string(),
    acted: z.boolean(),
  }),
  // Roda de hora em hora. Override via env não suportado pelo cron literal;
  // ajuste aqui se a demo precisar de cadência menor.
  cron: "0 * * * *",
})
  .then(perceive)
  .then(decideAndAct);

autonomousWorkflow.commit();
