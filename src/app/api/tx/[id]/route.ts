import { getTx, getTxMeta } from "@/server/casper/tx-store";

// Serves the full JSON of a pending transaction by its short ID. Consumed
// by the sign_with_wallet frontend tool, which needs the complete JSON (not
// truncated by the LLM) to open the Casper Wallet signature popup.
// Also returns human-readable metadata (amount/to/from/kind) so the card
// can show the user what they're about to sign.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const json = getTx(id);
  if (!json) {
    return Response.json({ error: "transaction not found or expired" }, { status: 404 });
  }
  return Response.json({ transactionJson: json, meta: getTxMeta(id) });
}
