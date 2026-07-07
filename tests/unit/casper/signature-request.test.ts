import { describe, expect, it, beforeAll } from "vitest";
import {
  NativeTransferBuilder,
  PrivateKey,
  KeyAlgorithm,
} from "casper-js-sdk";
import {
  assertValidTransactionJson,
  decodeTransfer,
  deriveState,
  partitionSignerNotifications,
} from "@/server/casper/signature-request";
import type {
  SignatureRequestRow,
  SignatureApprovalRow,
} from "@/shared/db/schema";

// Constrói uma tx de transfer nativa serializada (JSON) — a "tx base" de uma
// signature-request. amount em motes (1 CSPR = 1e9 motes).
async function buildTransferJson(amountMotes: string): Promise<string> {
  const from = await PrivateKey.generate(KeyAlgorithm.ED25519);
  const to = await PrivateKey.generate(KeyAlgorithm.ED25519);
  const tx = new NativeTransferBuilder()
    .from(from.publicKey)
    .target(to.publicKey)
    .amount(amountMotes)
    .id(1)
    .chainName("casper-test")
    .payment(100_000_000)
    .build();
  return JSON.stringify(tx.toJSON());
}

// Monta um SignatureRequestRow parcial — deriveState só lê requiredSigners +
// threshold; o resto do row não é tocado (cast seguro para o teste).
function req(
  requiredSigners: { publicKeyHex: string; label?: string }[],
  threshold: number,
): SignatureRequestRow {
  return { requiredSigners, threshold } as SignatureRequestRow;
}
function approval(signerPublicKeyHex: string): SignatureApprovalRow {
  return { signerPublicKeyHex } as SignatureApprovalRow;
}

const A = "01" + "a".repeat(64);
const B = "01" + "b".repeat(64);
const C = "01" + "c".repeat(64);

describe("deriveState — quórum", () => {
  it("sem approvals: pending = todos required, ready false", () => {
    const s = deriveState(req([{ publicKeyHex: A }, { publicKeyHex: B }], 2), []);
    expect(s.signed).toEqual([]);
    expect(s.pending.sort()).toEqual([A, B].sort());
    expect(s.ready).toBe(false);
  });

  it("conta só approvals de signatários EXIGIDOS (ignora ruído)", () => {
    const intruso = "01" + "f".repeat(64);
    const s = deriveState(
      req([{ publicKeyHex: A }, { publicKeyHex: B }], 2),
      [approval(A), approval(intruso)],
    );
    expect(s.signed).toEqual([A]);
    expect(s.ready).toBe(false); // intruso não conta p/ o quórum
  });

  it("ready quando signed atinge o threshold (boundary exato)", () => {
    const s = deriveState(
      req([{ publicKeyHex: A }, { publicKeyHex: B }], 2),
      [approval(A), approval(B)],
    );
    expect(s.ready).toBe(true);
    expect(s.pending).toEqual([]);
  });

  it("não fica ready em threshold-1", () => {
    const s = deriveState(
      req([{ publicKeyHex: A }, { publicKeyHex: B }, { publicKeyHex: C }], 3),
      [approval(A), approval(B)],
    );
    expect(s.ready).toBe(false);
    expect(s.pending).toEqual([C]);
  });

  it("approvals duplicadas do mesmo signatário não contam em dobro", () => {
    const s = deriveState(
      req([{ publicKeyHex: A }, { publicKeyHex: B }], 2),
      [approval(A), approval(A)],
    );
    expect(s.ready).toBe(false); // Set colapsa; só 1 signatário distinto
  });

  it("normaliza case ao casar approval com signatário exigido", () => {
    const s = deriveState(
      req([{ publicKeyHex: A }], 1),
      [approval(A.toUpperCase())],
    );
    expect(s.ready).toBe(true);
  });
});

describe("assertValidTransactionJson", () => {
  let validJson: string;
  beforeAll(async () => {
    validJson = await buildTransferJson("3000000000"); // 3 CSPR
  });

  it("aceita tx válida acima do mínimo (não lança)", () => {
    expect(() => assertValidTransactionJson(validJson)).not.toThrow();
  });

  it("recusa JSON acima do limite de tamanho → transaction_too_large", () => {
    const huge = "x".repeat(64_001);
    expect(() => assertValidTransactionJson(huge)).toThrow(
      "transaction_too_large",
    );
  });

  it("recusa JSON não-parseável como Transaction → invalid_transaction_json", () => {
    expect(() => assertValidTransactionJson('{"not":"a tx"}')).toThrow(
      "invalid_transaction_json",
    );
  });

  it("recusa transfer abaixo de 2.5 CSPR → transfer_below_minimum", async () => {
    const below = await buildTransferJson("2000000000"); // 2 CSPR
    expect(() => assertValidTransactionJson(below)).toThrow(
      "transfer_below_minimum",
    );
  });

  it("aceita exatamente 2.5 CSPR (boundary, < não <=)", async () => {
    const exact = await buildTransferJson("2500000000"); // 2.5 CSPR
    expect(() => assertValidTransactionJson(exact)).not.toThrow();
  });
});

describe("decodeTransfer", () => {
  it("decoda amount (motes→CSPR) e target de uma tx válida", async () => {
    const json = await buildTransferJson("3000000000");
    const dec = decodeTransfer(json);
    expect(dec.amountCspr).toBe("3");
    expect(dec.target).toMatch(/^01[0-9a-f]+/);
  });

  it("JSON malformado → { amountCspr: null, target: null }", () => {
    expect(decodeTransfer("lixo{")).toEqual({ amountCspr: null, target: null });
  });

  it("JSON válido mas não-transfer → amountCspr null (best-effort skip)", () => {
    expect(decodeTransfer('{"foo":1}')).toEqual({
      amountCspr: null,
      target: null,
    });
  });
});

describe("partitionSignerNotifications — quem recebe convite (sem duplicar)", () => {
  const PK_A = "01" + "a".repeat(64); // vinculada (vira userId)
  const PK_B = "01" + "b".repeat(64); // externa (só e-mail)
  const PK_C = "01" + "c".repeat(64); // externa, e-mail duplicado de B

  it("signatário com carteira vinculada → accountUserIds, não externalEmails", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [{ publicKeyHex: PK_A, email: "conta@x.com" }],
      walletToUser: new Map([[PK_A, "user-A"]]),
      createdByUserId: "creator",
    });
    // Tem conta: recebe por userId. NÃO entra em externalEmails mesmo tendo
    // e-mail — senão receberia o convite duas vezes.
    expect(plan.accountUserIds).toEqual(["user-A"]);
    expect(plan.externalEmails).toEqual([]);
  });

  it("signatário sem conta mas com e-mail → externalEmails", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [{ publicKeyHex: PK_B, email: "externo@x.com" }],
      walletToUser: new Map(),
      createdByUserId: "creator",
    });
    expect(plan.accountUserIds).toEqual([]);
    expect(plan.externalEmails).toEqual(["externo@x.com"]);
  });

  it("signatário sem conta e sem e-mail → não recebe nada", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [{ publicKeyHex: PK_B }],
      walletToUser: new Map(),
      createdByUserId: "creator",
    });
    expect(plan.accountUserIds).toEqual([]);
    expect(plan.externalEmails).toEqual([]);
  });

  it("criador não se auto-notifica mesmo com carteira vinculada", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [{ publicKeyHex: PK_A }],
      walletToUser: new Map([[PK_A, "creator"]]),
      createdByUserId: "creator",
    });
    expect(plan.accountUserIds).toEqual([]);
  });

  it("e-mail duplicado (case/espacos) entra só uma vez", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [
        { publicKeyHex: PK_B, email: "Dup@X.com" },
        { publicKeyHex: PK_C, email: " dup@x.com " },
      ],
      walletToUser: new Map(),
      createdByUserId: "creator",
    });
    // Mesmo e-mail normalizado → 1 convite. Preserva a 1ª forma trimada.
    expect(plan.externalEmails).toEqual(["Dup@X.com"]);
  });

  it("userId repetido no mapa (2 carteiras, mesmo dono) → 1 notificação", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [{ publicKeyHex: PK_A }, { publicKeyHex: PK_B }],
      walletToUser: new Map([
        [PK_A, "user-A"],
        [PK_B, "user-A"],
      ]),
      createdByUserId: "creator",
    });
    expect(plan.accountUserIds).toEqual(["user-A"]);
  });

  it("mistura: conta + externo + criador, sem sobreposição", () => {
    const plan = partitionSignerNotifications({
      requiredSigners: [
        { publicKeyHex: PK_A, email: "conta@x.com" }, // conta
        { publicKeyHex: PK_B, email: "externo@x.com" }, // externo
        { publicKeyHex: PK_C }, // criador, ignorado
      ],
      walletToUser: new Map([
        [PK_A, "user-A"],
        [PK_C, "creator"],
      ]),
      createdByUserId: "creator",
    });
    expect(plan.accountUserIds).toEqual(["user-A"]);
    expect(plan.externalEmails).toEqual(["externo@x.com"]);
  });
});
