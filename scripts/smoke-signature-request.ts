/**
 * Smoke E2E da camada multisig SaaS (Fase 7 do plano), com CRIPTOGRAFIA REAL:
 *   create (tx real) -> approve(A real) -> approve(B real) -> ready
 *   + idempotência (re-assinar não duplica)
 *   + autorização (signatário não exigido é rejeitado)
 *   + assinatura forjada é rejeitada (verifyTxSignature)
 *   + tx inválida é rejeitada (assertValidTransactionJson)
 *   + cancel
 *
 * NÃO faz broadcast on-chain (move fundos testnet, irreversível). Exercita o
 * caminho de coleta + TODO o hardening: tx parseável, prova de assinatura por
 * curva, idempotência, autorização, status guard. Keypairs gerados em runtime
 * (ED25519 + SECP256K1) e assinaturas produzidas pelo próprio SDK.
 *
 * Uso: ./node_modules/.bin/tsx --env-file=.env --conditions=react-server scripts/smoke-signature-request.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  PrivateKey,
  KeyAlgorithm,
  NativeTransferBuilder,
  CasperNetworkName,
  Transaction,
} from "casper-js-sdk";
import { db } from "../src/shared/db";
import { user, signatureRequests } from "../src/shared/db/schema";
import {
  createSignatureRequest,
  addApproval,
  getSignatureRequestState,
  cancelSignatureRequest,
  decodeTransfer,
} from "../src/server/casper/signature-request";
import { isValidPublicKeyHex } from "../src/server/casper/user-wallets";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

/** Assina a tx base com a chave dada e devolve o signatureHex (com tag). */
function signTx(transactionJson: string, pk: PrivateKey): string {
  const tx = Transaction.fromJSON(JSON.parse(transactionJson));
  tx.sign(pk);
  const approvals = (
    tx as unknown as {
      approvals: { signer: { toHex(): string }; signature: { toHex(): string } }[];
    }
  ).approvals;
  return approvals[approvals.length - 1].signature.toHex();
}

async function main() {
  const testUserId = `smoke-${randomUUID().slice(0, 8)}`;

  // Keypairs reais: A (pagadora, ED25519) + B (co-signatário, SECP256K1) +
  // outsider + forjador. Cobre as duas curvas suportadas.
  const keyA = PrivateKey.generate(KeyAlgorithm.ED25519);
  const keyB = PrivateKey.generate(KeyAlgorithm.SECP256K1);
  const keyOutsider = PrivateKey.generate(KeyAlgorithm.ED25519);
  const KEY_A = keyA.publicKey.toHex();
  const KEY_B = keyB.publicKey.toHex();
  const KEY_OUTSIDER = keyOutsider.publicKey.toHex();

  // tx base real: transfer nativo A -> B (2.5 CSPR).
  const builtTx = new NativeTransferBuilder()
    .from(keyA.publicKey)
    .target(keyB.publicKey)
    .amount("2500000000")
    .id(42)
    .chainName(CasperNetworkName.Testnet)
    .payment(100_000_000)
    .build();
  const transactionJson = JSON.stringify(builtTx.toJSON());

  // FK exige um user real. Cria um descartável.
  await db.insert(user).values({
    id: testUserId,
    name: "Smoke Test",
    email: `${testUserId}@smoke.local`,
    emailVerified: false,
  });

  let requestId: string | null = null;
  try {
    console.log("\n0) tx inválida é rejeitada (assertValidTransactionJson)");
    let badRejected = false;
    try {
      await createSignatureRequest({
        createdByUserId: testUserId,
        kind: "payment",
        description: "tx inválida",
        transactionJson: JSON.stringify({ mock: true }),
        requiredSigners: [{ publicKeyHex: KEY_A }],
        threshold: 1,
      });
    } catch (e) {
      badRejected =
        e instanceof Error && e.message === "invalid_transaction_json";
    }
    check("tx não parseável rejeitada (invalid_transaction_json)", badRejected);

    console.log("\n1) create (tx real)");
    const req = await createSignatureRequest({
      createdByUserId: testUserId,
      kind: "payment",
      description: "Smoke: pagar 2.5 CSPR (2 de 2)",
      transactionJson,
      requiredSigners: [
        { publicKeyHex: KEY_A, label: "pagadora" },
        { publicKeyHex: KEY_B, label: "co-signatário" },
      ],
      threshold: 2,
    });
    requestId = req.id;
    check("request criada com status pending", req.status === "pending");
    check("threshold = 2", req.threshold === 2);

    console.log("\n1b) pubkeys das 2 curvas são aceitas (ED25519 + SECP256K1)");
    check("KEY_A (ED25519, 66 hex) válida", isValidPublicKeyHex(KEY_A));
    check("KEY_B (SECP256K1, 68 hex) válida", isValidPublicKeyHex(KEY_B));

    console.log("\n1c) decodeTransfer extrai valor/destino REAIS da tx");
    const decoded = decodeTransfer(transactionJson);
    check("amount decodado = 2.5 CSPR", decoded.amountCspr === "2.5");
    check("target decodado = KEY_B", decoded.target === KEY_B);

    console.log("\n2) approve(A) — assinatura ED25519 real");
    const s1 = await addApproval({
      requestId: req.id,
      signerPublicKeyHex: KEY_A,
      signatureHex: signTx(transactionJson, keyA),
    });
    check("1 assinatura registrada", s1.signed.length === 1);
    check("ainda não ready (1/2)", s1.ready === false);
    check("status segue pending", s1.request.status === "pending");

    console.log("\n3) idempotência: re-assinar A não duplica");
    const sDup = await addApproval({
      requestId: req.id,
      signerPublicKeyHex: KEY_A,
      signatureHex: signTx(transactionJson, keyA),
    });
    check("continua 1 assinatura (idempotente)", sDup.signed.length === 1);

    console.log("\n4) autorização: signatário não exigido é rejeitado");
    let rejected = false;
    try {
      await addApproval({
        requestId: req.id,
        signerPublicKeyHex: KEY_OUTSIDER,
        signatureHex: signTx(transactionJson, keyOutsider),
      });
    } catch (e) {
      rejected = e instanceof Error && e.message === "signer_not_required";
    }
    check("outsider rejeitado (signer_not_required)", rejected);

    console.log("\n5) assinatura forjada de B é rejeitada (verifyTxSignature)");
    let forgedRejected = false;
    try {
      // assinatura do outsider apresentada como se fosse de B → não bate o hash
      await addApproval({
        requestId: req.id,
        signerPublicKeyHex: KEY_B,
        signatureHex: signTx(transactionJson, keyOutsider),
      });
    } catch (e) {
      forgedRejected = e instanceof Error && e.message === "invalid_signature";
    }
    check("assinatura forjada rejeitada (invalid_signature)", forgedRejected);

    console.log("\n6) approve(B) — assinatura SECP256K1 real -> quórum");
    const s2 = await addApproval({
      requestId: req.id,
      signerPublicKeyHex: KEY_B,
      signatureHex: signTx(transactionJson, keyB),
    });
    check("2 assinaturas", s2.signed.length === 2);
    check("ready = true", s2.ready === true);
    check("status promovido a ready", s2.request.status === "ready");

    console.log("\n7) getState reflete o estado persistido");
    const state = await getSignatureRequestState(req.id);
    check("state.ready persistido", state?.ready === true);
    check("pending vazio", state?.pending.length === 0);

    console.log("\n8) cancel");
    await cancelSignatureRequest(req.id);
    const cancelled = await getSignatureRequestState(req.id);
    check("status cancelled", cancelled?.request.status === "cancelled");
  } finally {
    // Limpeza: cascade apaga approvals + request ao apagar o user.
    if (requestId) {
      await db
        .delete(signatureRequests)
        .where(eq(signatureRequests.id, requestId));
    }
    await db.delete(user).where(eq(user.id, testUserId));
  }

  console.log(`\n=== ${pass} passou, ${fail} falhou ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO FATAL:", e);
  process.exit(1);
});
