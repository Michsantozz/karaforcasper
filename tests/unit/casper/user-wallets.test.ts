import { describe, expect, it } from "vitest";
import { PrivateKey, KeyAlgorithm } from "casper-js-sdk";
import {
  isValidPublicKeyHex,
  verifyMessageSignature,
} from "@/server/casper/user-wallets";

// Gate de segurança do fluxo de vínculo de carteira (SIWE-style). Duas funções
// puras e cripto — sem DB. verifyMessageSignature é a prova-de-posse: sem ela,
// qualquer um vincularia a pubkey alheia.

// Assina uma mensagem como a Casper Wallet faz: prefixa "Casper Message:\n" e
// devolve a assinatura CRUA (64 bytes hex), sem a tag de algoritmo.
async function walletSign(pk: PrivateKey, message: string): Promise<string> {
  const bytes = new TextEncoder().encode(`Casper Message:\n${message}`);
  const raw = await pk.sign(bytes);
  return Buffer.from(raw).toString("hex");
}

describe("isValidPublicKeyHex", () => {
  const ed = "01" + "a".repeat(64); // ED25519: 01 + 64 hex
  const secp = "02" + "b".repeat(66); // SECP256K1: 02 + 66 hex

  it("aceita ED25519 (01 + 64 hex)", () => {
    expect(isValidPublicKeyHex(ed)).toBe(true);
  });

  it("aceita SECP256K1 (02 + 66 hex)", () => {
    expect(isValidPublicKeyHex(secp)).toBe(true);
  });

  it("normaliza case (uppercase válido)", () => {
    expect(isValidPublicKeyHex(ed.toUpperCase())).toBe(true);
  });

  it("apara espaços antes de validar", () => {
    expect(isValidPublicKeyHex(`  ${ed}  `)).toBe(true);
  });

  it("recusa ED25519 com tamanho errado (off-by-one)", () => {
    expect(isValidPublicKeyHex("01" + "a".repeat(63))).toBe(false);
    expect(isValidPublicKeyHex("01" + "a".repeat(65))).toBe(false);
  });

  it("recusa SECP256K1 com tamanho errado", () => {
    expect(isValidPublicKeyHex("02" + "b".repeat(64))).toBe(false);
  });

  it("recusa prefixo inválido (00 / 03 / sem prefixo)", () => {
    expect(isValidPublicKeyHex("00" + "a".repeat(64))).toBe(false);
    expect(isValidPublicKeyHex("03" + "a".repeat(64))).toBe(false);
    expect(isValidPublicKeyHex("a".repeat(64))).toBe(false);
  });

  it("recusa caracteres não-hex", () => {
    expect(isValidPublicKeyHex("01" + "z".repeat(64))).toBe(false);
  });

  it("recusa string vazia", () => {
    expect(isValidPublicKeyHex("")).toBe(false);
  });
});

describe("verifyMessageSignature — caminho feliz (regressão do bug de tag)", () => {
  // Antes do fix, o SDK exigia a assinatura COM tag (65 bytes) mas a função
  // removia o 1º byte antes de verificar — TODA assinatura crua válida dava
  // false, quebrando o vínculo de carteira. Estes testes travam o fix.

  for (const [name, algo] of [
    ["ED25519", KeyAlgorithm.ED25519],
    ["SECP256K1", KeyAlgorithm.SECP256K1],
  ] as const) {
    it(`aceita uma assinatura crua VÁLIDA (${name})`, async () => {
      const pk = await PrivateKey.generate(algo);
      const publicKeyHex = pk.publicKey.toHex();
      const message = "nonce-de-vinculo-123";
      const signatureHex = await walletSign(pk, message);
      expect(
        verifyMessageSignature({ message, publicKeyHex, signatureHex }),
      ).toBe(true);
    });
  }
});

describe("verifyMessageSignature — rejeições (fail-closed)", () => {
  it("recusa assinatura de OUTRA chave (mismatch signer/key)", async () => {
    const signer = await PrivateKey.generate(KeyAlgorithm.ED25519);
    const other = await PrivateKey.generate(KeyAlgorithm.ED25519);
    const message = "nonce-x";
    const signatureHex = await walletSign(signer, message);
    // assinatura do `signer`, mas verificada contra a pubkey do `other`.
    expect(
      verifyMessageSignature({
        message,
        publicKeyHex: other.publicKey.toHex(),
        signatureHex,
      }),
    ).toBe(false);
  });

  it("recusa assinatura sobre OUTRA mensagem (replay/mismatch)", async () => {
    const pk = await PrivateKey.generate(KeyAlgorithm.ED25519);
    const signatureHex = await walletSign(pk, "mensagem-original");
    expect(
      verifyMessageSignature({
        message: "mensagem-diferente",
        publicKeyHex: pk.publicKey.toHex(),
        signatureHex,
      }),
    ).toBe(false);
  });

  it("recusa assinatura adulterada", async () => {
    const pk = await PrivateKey.generate(KeyAlgorithm.ED25519);
    const message = "nonce-y";
    const good = await walletSign(pk, message);
    // vira o último byte hex.
    const tampered = good.slice(0, -1) + (good.at(-1) === "0" ? "1" : "0");
    expect(
      verifyMessageSignature({
        message,
        publicKeyHex: pk.publicKey.toHex(),
        signatureHex: tampered,
      }),
    ).toBe(false);
  });

  it("recusa publicKeyHex malformada (fail-closed, sem lançar)", () => {
    expect(
      verifyMessageSignature({
        message: "x",
        publicKeyHex: "não-é-hex",
        signatureHex: "00".repeat(64),
      }),
    ).toBe(false);
  });
});
