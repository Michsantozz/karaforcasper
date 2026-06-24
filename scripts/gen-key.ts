import { PrivateKey, KeyAlgorithm } from "casper-js-sdk";
import { writeFile } from "node:fs/promises";

// Gera uma carteira ED25519 para o agente e salva o secret key em PEM.
// Uso: pnpm tsx scripts/gen-key.ts
async function main() {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const pem = key.toPem();
  await writeFile("./agent-secret.pem", pem, "utf8");
  console.log("Carteira do agente gerada.");
  console.log("Public key (hex):", key.publicKey.toHex());
  console.log("Secret key salvo em: ./agent-secret.pem");
  console.log("\nFunde no Testnet faucet: https://testnet.cspr.live/tools/faucet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
