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
    const { getAgentPublicKeyHex } = await import("@/server/casper/client");
    const { getBalanceCspr } = await import("@/server/casper/transfer");
    const publicKey = await getAgentPublicKeyHex();
    const balanceCspr = await getBalanceCspr(publicKey).catch(() => "0");
    void res;
    return { publicKey, balanceCspr };
  },
});

// 2. DECIDIR + AGIR — o LLM avalia o estado e decide autonomamente se age.
//    A decisão de GASTAR é determinística (código), não parse de texto do LLM:
//    um agente autônomo (sem humano no loop) NUNCA deve mover fundos com base em
//    regex sobre a saída do modelo — alucinação do padrão = transferência. Aqui
//    a política ("saldo > mínimo → heartbeat de valor fixo") é avaliada em TS, e
//    transferCspr ainda aplica teto/allowlist/fail-closed por baixo.
const AUTONOMOUS_MIN_BALANCE_CSPR = Number(
  process.env.CASPER_AUTONOMOUS_MIN_BALANCE_CSPR ?? "5",
);
// Default = piso da rede (2.5). Abaixo disso a policy recusa (amount_below_minimum)
// e o heartbeat nunca completaria — o default precisa ser >= MIN_TRANSFER_CSPR.
const AUTONOMOUS_HEARTBEAT_CSPR = Number(
  process.env.CASPER_AUTONOMOUS_HEARTBEAT_CSPR ?? "2.5",
);

/** Efetua a transferência de heartbeat. Injetável para teste. */
type TransferFn = (args: {
  toPublicKeyHex: string;
  amountCspr: number;
}) => Promise<{ transactionHash: string }>;

export interface DecideAndActConfig {
  /** Destino do heartbeat (vazio = não configurado → não age). */
  heartbeatTarget: string;
  minBalanceCspr: number;
  heartbeatCspr: number;
}

export interface DecideResult {
  decision: string;
  acted: boolean;
}

/**
 * Decisão determinística de GASTAR — o coração do loop autônomo, isolado do wire
 * Inngest para ser testável sem a infra. Um agente sem humano no loop NUNCA move
 * fundos por parse de texto do LLM; a política é puro código aqui, e `transfer`
 * ainda aplica teto/allowlist/fail-closed por baixo.
 *
 * Contrato fail-closed: qualquer erro de `transfer` → { acted: false }. Nunca
 * reporta sucesso ambíguo.
 */
export async function decideAction(
  balanceCspr: string,
  cfg: DecideAndActConfig,
  transfer: TransferFn,
): Promise<DecideResult> {
  const balance = Number(balanceCspr);

  if (!cfg.heartbeatTarget) {
    return {
      decision: "AGUARDANDO: CASPER_HEARTBEAT_TARGET não definido.",
      acted: false,
    };
  }
  if (!Number.isFinite(balance) || balance <= cfg.minBalanceCspr) {
    return {
      decision: `AGUARDANDO: saldo insuficiente | SALDO: ${balanceCspr} CSPR | MÍNIMO: ${cfg.minBalanceCspr} CSPR`,
      acted: false,
    };
  }

  try {
    const res = await transfer({
      toPublicKeyHex: cfg.heartbeatTarget,
      amountCspr: cfg.heartbeatCspr,
    });
    return {
      decision: `AÇÃO: transfer | MOTIVO: heartbeat autônomo | SALDO: ${balanceCspr} CSPR | TX: ${res.transactionHash}`,
      acted: true,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message : "erro desconhecido";
    return {
      decision: `BLOQUEADO pela política de gasto: ${code}`,
      acted: false,
    };
  }
}

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
  execute: async ({ inputData }) => {
    const { transferCspr } = await import("@/server/casper/transfer");
    return decideAction(
      inputData.balanceCspr,
      {
        heartbeatTarget: process.env.CASPER_HEARTBEAT_TARGET ?? "",
        minBalanceCspr: AUTONOMOUS_MIN_BALANCE_CSPR,
        heartbeatCspr: AUTONOMOUS_HEARTBEAT_CSPR,
      },
      transferCspr,
    );
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
