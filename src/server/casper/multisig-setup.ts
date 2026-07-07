import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  SessionBuilder,
  Args,
  CLValue,
  Key,
  PublicKey,
} from "casper-js-sdk";
import { CHAIN_NAME } from "./client";
import { putTx } from "./tx-store";

// Gas para os deploys de session (key management). ~3 CSPR é folgado.
const SETUP_PAYMENT_MOTES = 3_000_000_000;

const WASM_DIR = path.join(process.cwd(), "src/lib/casper/wasm");

async function loadWasm(name: string): Promise<Uint8Array> {
  const buf = await readFile(path.join(WASM_DIR, name));
  return new Uint8Array(buf);
}

/** account-hash-… a partir da public key hex (formato exigido pelo arg `new_key`). */
function accountHashKey(publicKeyHex: string): Key {
  const ah = PublicKey.fromHex(publicKeyHex).accountHash();
  return Key.newKey(ah.toPrefixedString());
}

export interface PreparedSetupStep {
  /** O que este passo faz, em linguagem natural. */
  label: string;
  /** ID curto da tx no store — o cliente busca o JSON íntegro por ele. */
  txId: string;
}

export interface PreparedMultisigSetup {
  /** Conta primária (dona) que assina e é configurada. */
  primaryPublicKeyHex: string;
  /** Passos a executar EM ORDEM (cada um: assinar + broadcast). */
  steps: PreparedSetupStep[];
  /** Resumo da configuração resultante. */
  config: {
    primaryWeight: number;
    associatedKeys: { publicKeyHex: string; weight: number }[];
    deploymentThreshold: number;
    keyManagementThreshold: number;
  };
  chainName: string;
}

/**
 * Monta (sem assinar) a sequência de deploys de SESSION WASM que transforma a
 * conta primária numa conta MULTISIG NATIVA do Casper:
 *
 *  1) add_account.wasm — adiciona cada signatário como associated key (peso).
 *  2) update_thresholds.wasm — define o deployment/key_management threshold.
 *
 * Cada passo é uma tx que a CONTA PRIMÁRIA assina (via carteira) e submete na
 * ordem. Depois disso, a rede passa a EXIGIR o quórum nativamente — diferente
 * do multisig "demonstrável", aqui o enforcement é da blockchain.
 *
 * IMPORTANTE: o peso da própria chave primária precisa ser >= key_management
 * threshold para ela conseguir gerenciar a conta; senão a conta fica travada.
 * Por isso o threshold de key_management é configurável e deve ser planejado.
 */
export async function prepareMultisigSetup(args: {
  primaryPublicKeyHex: string;
  /** Signatários a adicionar (além da chave primária). */
  associates: { publicKeyHex: string; weight: number }[];
  deploymentThreshold: number;
  keyManagementThreshold: number;
  /**
   * Peso a atribuir à chave primária ANTES de definir os thresholds. Deve ser
   * >= keyManagementThreshold para a conta primária conseguir se gerenciar
   * sozinha (evita travar a conta). Se omitido, usa keyManagementThreshold.
   */
  primaryWeight?: number;
}): Promise<PreparedMultisigSetup> {
  const primary = PublicKey.fromHex(args.primaryPublicKeyHex);
  const addWasm = await loadWasm("add_account.wasm");
  const thrWasm = await loadWasm("update_thresholds.wasm");
  const updWasm = await loadWasm("update_associated_keys.wasm");
  const primaryWeight = args.primaryWeight ?? args.keyManagementThreshold;

  const steps: PreparedSetupStep[] = [];

  // 0) Sobe o peso da chave primária (segurança: ela precisa conseguir gerenciar
  //    a conta sozinha, senão trava). Tem que vir ANTES dos thresholds.
  {
    const tx = new SessionBuilder()
      .from(primary)
      .wasm(updWasm)
      .runtimeArgs(
        Args.fromMap({
          associated_key: CLValue.newCLKey(accountHashKey(args.primaryPublicKeyHex)),
          new_weight: CLValue.newCLUint8(primaryWeight),
        }),
      )
      .chainName(CHAIN_NAME)
      .payment(SETUP_PAYMENT_MOTES)
      .build();

    steps.push({
      label: `Elevar peso da chave primária para ${primaryWeight} (evita travar a conta)`,
      txId: putTx(JSON.stringify(tx.toJSON()), {
        kind: "setup_multisig",
        from: args.primaryPublicKeyHex,
      }),
    });
  }

  // 1) Um deploy add_account por associado.
  for (const a of args.associates) {
    const tx = new SessionBuilder()
      .from(primary)
      .wasm(addWasm)
      .runtimeArgs(
        Args.fromMap({
          new_key: CLValue.newCLKey(accountHashKey(a.publicKeyHex)),
          weight: CLValue.newCLUint8(a.weight),
        }),
      )
      .chainName(CHAIN_NAME)
      .payment(SETUP_PAYMENT_MOTES)
      .build();

    steps.push({
      label: `Adicionar ${a.publicKeyHex.slice(0, 10)}… como signatário (peso ${a.weight})`,
      txId: putTx(JSON.stringify(tx.toJSON()), {
        kind: "setup_multisig",
        from: args.primaryPublicKeyHex,
        to: a.publicKeyHex,
      }),
    });
  }

  // 2) Define os thresholds (precisa vir DEPOIS de adicionar as chaves).
  const thrTx = new SessionBuilder()
    .from(primary)
    .wasm(thrWasm)
    .runtimeArgs(
      Args.fromMap({
        deployment_threshold: CLValue.newCLUint8(args.deploymentThreshold),
        key_management_threshold: CLValue.newCLUint8(args.keyManagementThreshold),
      }),
    )
    .chainName(CHAIN_NAME)
    .payment(SETUP_PAYMENT_MOTES)
    .build();

  steps.push({
    label: `Definir quórum: deployment=${args.deploymentThreshold}, key_management=${args.keyManagementThreshold}`,
    txId: putTx(JSON.stringify(thrTx.toJSON()), {
      kind: "setup_multisig",
      from: args.primaryPublicKeyHex,
    }),
  });

  return {
    primaryPublicKeyHex: args.primaryPublicKeyHex,
    steps,
    config: {
      primaryWeight,
      associatedKeys: args.associates,
      deploymentThreshold: args.deploymentThreshold,
      keyManagementThreshold: args.keyManagementThreshold,
    },
    chainName: CHAIN_NAME,
  };
}
