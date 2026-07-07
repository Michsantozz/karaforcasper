import { PrivateKey, KeyAlgorithm } from "casper-js-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Gera uma carteira ED25519 para o agente e salva o secret key em PEM.
// Grava FORA do repo (~/.casper/keys) — padrão do SDK oficial: chave privada
// nunca mora na raiz do projeto. Override o destino via CASPER_AGENT_SECRET_KEY_PATH.
// Uso: pnpm tsx scripts/gen-key.ts
async function main() {
  const dest =
    process.env.CASPER_AGENT_SECRET_KEY_PATH ??
    join(homedir(), ".casper", "keys", "agent-secret.pem");

  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const pem = key.toPem();

  // Cria ~/.casper/keys com permissão restrita antes de gravar.
  await mkdir(join(dest, ".."), { recursive: true, mode: 0o700 });
  await writeFile(dest, pem, { encoding: "utf8", mode: 0o600 });

  console.log("Carteira do agente gerada.");
  console.log("Public key (hex):", key.publicKey.toHex());
  console.log("Secret key salvo em:", dest);
  console.log("\nFunde no Testnet faucet: https://testnet.cspr.live/tools/faucet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
