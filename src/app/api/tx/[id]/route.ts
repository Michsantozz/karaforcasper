import { getTx, getTxMeta } from "@/server/casper/tx-store";

// Entrega o JSON íntegro de uma transação pendente pelo ID curto. Consumido
// pela frontend tool sign_with_wallet, que precisa do JSON completo (não
// truncado pelo LLM) para abrir o popup de assinatura da Casper Wallet.
// Retorna também os metadados legíveis (amount/to/from/kind) para que o card
// mostre ao usuário o que ele está prestes a assinar.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const json = getTx(id);
  if (!json) {
    return Response.json({ error: "tx não encontrada ou expirada" }, { status: 404 });
  }
  return Response.json({ transactionJson: json, meta: getTxMeta(id) });
}
