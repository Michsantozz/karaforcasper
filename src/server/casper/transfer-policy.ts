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
 * Três camadas:
 *  1. Teto por transação (MAX_TRANSFER_CSPR).
 *  2. Allowlist de destinos (TRANSFER_ALLOWLIST) — se definida, só endereços nela.
 *  3. Fail-closed: valores inválidos (NaN/≤0/acima do teto) são recusados.
 *
 * O human-in-the-loop (requireApproval do Mastra) é a 4ª camada, aplicada na tool.
 * Estas guardas continuam valendo mesmo se a aprovação for burlada no handler.
 */

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
      | "amount_exceeds_limit"
      | "destination_not_allowed",
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

  if (!Number.isFinite(amountCspr) || amountCspr <= 0) {
    throw new TransferPolicyError(
      "amount_invalid",
      `valor de transferência inválido: ${amountCspr}`,
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
