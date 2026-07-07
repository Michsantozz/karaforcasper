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

// Gas for the session deploys (key management). ~3 CSPR is plenty.
const SETUP_PAYMENT_MOTES = 3_000_000_000;

const WASM_DIR = path.join(process.cwd(), "src/server/casper/wasm");

async function loadWasm(name: string): Promise<Uint8Array> {
  const buf = await readFile(path.join(WASM_DIR, name));
  return new Uint8Array(buf);
}

/** account-hash-… from the public key hex (format required by the `new_key` arg). */
function accountHashKey(publicKeyHex: string): Key {
  const ah = PublicKey.fromHex(publicKeyHex).accountHash();
  return Key.newKey(ah.toPrefixedString());
}

export interface PreparedSetupStep {
  /** What this step does, in plain language. */
  label: string;
  /** Short tx ID in the store — the client fetches the full JSON by it. */
  txId: string;
}

export interface PreparedMultisigSetup {
  /** Primary (owner) account that signs and is being configured. */
  primaryPublicKeyHex: string;
  /** Steps to execute IN ORDER (each one: sign + broadcast). */
  steps: PreparedSetupStep[];
  /** Summary of the resulting configuration. */
  config: {
    primaryWeight: number;
    associatedKeys: { publicKeyHex: string; weight: number }[];
    deploymentThreshold: number;
    keyManagementThreshold: number;
  };
  chainName: string;
}

/**
 * Builds (without signing) the sequence of SESSION WASM deploys that turns
 * the primary account into a Casper NATIVE MULTISIG account:
 *
 *  1) add_account.wasm — adds each signer as an associated key (weight).
 *  2) update_thresholds.wasm — sets the deployment/key_management threshold.
 *
 * Each step is a tx that the PRIMARY ACCOUNT signs (via wallet) and submits in
 * order. After this, the network starts ENFORCING the quorum natively —
 * unlike the "demonstrable" multisig, here enforcement is done by the blockchain.
 *
 * IMPORTANT: the primary key's own weight needs to be >= the key_management
 * threshold for it to be able to manage the account; otherwise the account
 * gets locked out. That's why the key_management threshold is configurable
 * and must be planned.
 */
export async function prepareMultisigSetup(args: {
  primaryPublicKeyHex: string;
  /** Signers to add (besides the primary key). */
  associates: { publicKeyHex: string; weight: number }[];
  deploymentThreshold: number;
  keyManagementThreshold: number;
  /**
   * Weight to assign to the primary key BEFORE setting the thresholds. Must be
   * >= keyManagementThreshold for the primary account to be able to manage
   * itself alone (avoids locking the account). If omitted, uses keyManagementThreshold.
   */
  primaryWeight?: number;
}): Promise<PreparedMultisigSetup> {
  const primary = PublicKey.fromHex(args.primaryPublicKeyHex);
  const addWasm = await loadWasm("add_account.wasm");
  const thrWasm = await loadWasm("update_thresholds.wasm");
  const updWasm = await loadWasm("update_associated_keys.wasm");
  const primaryWeight = args.primaryWeight ?? args.keyManagementThreshold;

  const steps: PreparedSetupStep[] = [];

  // 0) Raises the primary key's weight (safety: it needs to be able to manage
  //    the account alone, otherwise it locks out). Must come BEFORE the thresholds.
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
      label: `Raise primary key weight to ${primaryWeight} (avoids locking the account)`,
      txId: putTx(JSON.stringify(tx.toJSON()), {
        kind: "setup_multisig",
        from: args.primaryPublicKeyHex,
      }),
    });
  }

  // 1) One add_account deploy per associate.
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
      label: `Add ${a.publicKeyHex.slice(0, 10)}… as signer (weight ${a.weight})`,
      txId: putTx(JSON.stringify(tx.toJSON()), {
        kind: "setup_multisig",
        from: args.primaryPublicKeyHex,
        to: a.publicKeyHex,
      }),
    });
  }

  // 2) Sets the thresholds (must come AFTER adding the keys).
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
    label: `Set quorum: deployment=${args.deploymentThreshold}, key_management=${args.keyManagementThreshold}`,
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
