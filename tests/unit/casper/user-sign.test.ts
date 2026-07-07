import { describe, expect, it } from "vitest";
import { withAlgorithmTag } from "@/server/casper/user-sign";

// withAlgorithmTag prefixa a tag de curva (01=ED25519, 02=SECP256K1) numa
// assinatura crua de 64 bytes. É reusada por multisig, signature-request e
// user-wallets — um bug aqui corrompe verificação/broadcast em todo lugar.

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");
const raw64 = "ab".repeat(64); // 64 bytes crus
const ED = "01" + "0".repeat(64); // pubkey ED25519
const SECP = "02" + "0".repeat(66); // pubkey SECP256K1

describe("withAlgorithmTag — tagging de assinatura crua (64 bytes)", () => {
  it("ED25519 (pubkey 01…) prefixa 0x01 → 65 bytes", () => {
    const out = withAlgorithmTag(raw64, ED);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x01);
  });

  it("SECP256K1 (pubkey 02…) prefixa 0x02 → 65 bytes", () => {
    const out = withAlgorithmTag(raw64, SECP);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x02);
  });

  it("prefixo da pubkey é case-insensitive (01 uppercase)", () => {
    const out = withAlgorithmTag(raw64, "01".toUpperCase() + "0".repeat(64));
    expect(out[0]).toBe(0x01);
  });

  it("qualquer prefixo != 01 cai em SECP (0x02) — inclusive pubkey malformada", () => {
    // Documenta o comportamento atual: não valida a pubkey, assume SECP.
    expect(withAlgorithmTag(raw64, "ff" + "0".repeat(64))[0]).toBe(0x02);
  });
});

describe("withAlgorithmTag — idempotência (já taggeada, 65 bytes)", () => {
  it("65 bytes começando com 0x01 volta inalterada", () => {
    const already = hex([0x01, ...Array(64).fill(0xaa)]);
    const out = withAlgorithmTag(already, ED);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x01);
  });

  it("65 bytes começando com 0x02 volta inalterada", () => {
    const already = hex([0x02, ...Array(64).fill(0xbb)]);
    const out = withAlgorithmTag(already, SECP);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x02);
  });
});

describe("withAlgorithmTag — edge case: 65 bytes com 1º byte inválido", () => {
  it("65 bytes começando com byte != 01/02 é RE-taggeado (vira 66 bytes)", () => {
    // Comportamento atual documentado: o guard de idempotência exige 1º byte
    // 01/02; uma assinatura de 65 bytes com primeiro byte estranho não é
    // reconhecida como já-taggeada, então recebe outra tag e vira 66 bytes.
    // Isso é uma quina (input inesperado), fixada aqui para pegar regressão.
    const weird = hex([0xff, ...Array(64).fill(0xaa)]);
    const out = withAlgorithmTag(weird, ED);
    expect(out.length).toBe(66);
    expect(out[0]).toBe(0x01);
  });
});
