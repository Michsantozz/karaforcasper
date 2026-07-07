import "server-only";

/**
 * Política de gasto da carteira DO AGENTE — enforcement em CÓDIGO, não no prompt.
 *
 * Motivo: `transfer_cspr` assina e transmite fundos on-chain a partir da carteira
 * do agente. Antes, o único freio era uma instrução textual no system prompt
 * ("confirme com o usuário") — convenção, não garantia: prompt-injection via chat
 * ou uma alucinação do loop autônomo bastavam pra drenar a carteira. Aqui a
 * política é verificada em código, fail-closed, independente do que o LLM decide.
 *
 * Camadas:
 *  1. Piso da rede (MIN_TRANSFER_CSPR): o Casper recusa transfer nativo abaixo
 *     de 2.5 CSPR com -32016. Barramos ANTES de assinar/pagar gas — senão todo
 *     transfer pequeno (ex.: heartbeat autônomo default 1 CSPR) queima gas e falha.
 *  2. Teto por transação (MAX_TRANSFER_CSPR).
 *  3. Allowlist de destinos (TRANSFER_ALLOWLIST) — se definida, só endereços nela.
 *  4. Fail-closed: valores inválidos (NaN/≤0/fora da faixa) são recusados, e um
 *     teto MAL CONFIGURADO (env não-numérico) é tratado como erro, não como
 *     "sem teto" — senão o limite de gasto sumiria silenciosamente.
 *
 * O human-in-the-loop (requireApproval do Mastra) é a última camada, na tool.
 * Estas guardas continuam valendo mesmo se a aprovação for burlada no handler.
 */

/**
 * Piso da rede para transfer nativo, em CSPR. O nó recusa abaixo disso (-32016
 * "insufficient transfer amount"). Constante do protocolo, não configurável.
 */
export const MIN_TRANSFER_CSPR = 2.5;

/** Teto por transferência do agente, em CSPR. Default conservador: 5 CSPR. */
export const MAX_TRANSFER_CSPR = Number(
  process.env.AGENT_MAX_TRANSFER_CSPR ?? "5",
);

/**
 * Allowlist de destinos (public keys hex, separadas por vírgula). Se vazia, não
 * há restrição de destino — recomendado definir em produção. Normalizada p/
 * lowercase para comparação estável.
 */
const TRANSFER_ALLOWLIST: ReadonlySet<string> = new Set(
  (process.env.AGENT_TRANSFER_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export class TransferPolicyError extends Error {
  constructor(
    readonly code:
      | "amount_invalid"
      | "amount_below_minimum"
      | "amount_exceeds_limit"
      | "destination_not_allowed"
      | "policy_misconfigured",
    message: string,
  ) {
    super(message);
    this.name = "TransferPolicyError";
  }
}

/**
 * Valida uma transferência do agente contra a política. Lança TransferPolicyError
 * (fail-closed) se qualquer regra falhar. Retorna void se aprovada.
 */
export function assertTransferAllowed(args: {
  toPublicKeyHex: string;
  amountCspr: number;
}): void {
  const { toPublicKeyHex, amountCspr } = args;

  // Teto mal configurado (env não-numérico → NaN) é ERRO, não "sem teto". Sem
  // esta checagem, `amountCspr > NaN` seria sempre false e o limite de gasto
  // desapareceria silenciosamente. Fail-closed: recusa até o operador corrigir.
  if (!Number.isFinite(MAX_TRANSFER_CSPR) || MAX_TRANSFER_CSPR <= 0) {
    throw new TransferPolicyError(
      "policy_misconfigured",
      `AGENT_MAX_TRANSFER_CSPR inválido: ${process.env.AGENT_MAX_TRANSFER_CSPR}`,
    );
  }

  if (!Number.isFinite(amountCspr) || amountCspr <= 0) {
    throw new TransferPolicyError(
      "amount_invalid",
      `valor de transferência inválido: ${amountCspr}`,
    );
  }

  if (amountCspr < MIN_TRANSFER_CSPR) {
    throw new TransferPolicyError(
      "amount_below_minimum",
      `transferência de ${amountCspr} CSPR abaixo do mínimo da rede (${MIN_TRANSFER_CSPR} CSPR)`,
    );
  }

  if (amountCspr > MAX_TRANSFER_CSPR) {
    throw new TransferPolicyError(
      "amount_exceeds_limit",
      `transferência de ${amountCspr} CSPR excede o teto de ${MAX_TRANSFER_CSPR} CSPR`,
    );
  }

  if (
    TRANSFER_ALLOWLIST.size > 0 &&
    !TRANSFER_ALLOWLIST.has(toPublicKeyHex.toLowerCase())
  ) {
    throw new TransferPolicyError(
      "destination_not_allowed",
      `destino ${toPublicKeyHex} não está na allowlist do agente`,
    );
  }
}
