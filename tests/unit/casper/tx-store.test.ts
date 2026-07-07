import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putTx, getTx, getTxMeta } from "@/server/casper/tx-store";

// Store efêmero de tx pendentes de assinatura. Puro, in-memory, TTL de 30 min.
// O store é módulo-global (Map), então cada `it` usa um id fresco (retornado por
// putTx) para não vazar entre casos.

describe("tx-store — round-trip", () => {
  it("putTx devolve id curto de 8 chars e getTx recupera o JSON íntegro", () => {
    const json = JSON.stringify({ hello: "world", n: 42 });
    const id = putTx(json);
    expect(id).toHaveLength(8);
    expect(getTx(id)).toBe(json);
  });

  it("getTxMeta devolve os metadados quando fornecidos", () => {
    const meta = { kind: "transfer", amountCspr: "2.5", to: "01ab" };
    const id = putTx("{}", meta);
    expect(getTxMeta(id)).toEqual(meta);
  });

  it("getTxMeta devolve null quando putTx foi chamado sem meta", () => {
    const id = putTx("{}");
    expect(getTxMeta(id)).toBeNull();
  });

  it("cada putTx gera um id distinto", () => {
    const a = putTx("{}");
    const b = putTx("{}");
    expect(a).not.toBe(b);
  });
});

describe("tx-store — id desconhecido", () => {
  it("getTx devolve null para id que nunca existiu", () => {
    expect(getTx("deadbeef")).toBeNull();
  });

  it("getTxMeta devolve null para id que nunca existiu", () => {
    expect(getTxMeta("deadbeef")).toBeNull();
  });
});

describe("tx-store — expiração (TTL 30 min)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("entrada some do getTx depois de passar o TTL", () => {
    const id = putTx('{"v":1}');
    expect(getTx(id)).toBe('{"v":1}');

    // avança além do TTL (30 min); getEntry faz o expiry lazy na leitura.
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(getTx(id)).toBeNull();
    expect(getTxMeta(id)).toBeNull();
  });

  it("entrada ainda vale um instante antes do TTL", () => {
    const id = putTx('{"v":2}');
    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(getTx(id)).toBe('{"v":2}');
  });

  it("putTx faz sweep das entradas expiradas ao inserir novas", () => {
    const stale = putTx('{"stale":true}');
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    // um novo put dispara sweep(); a entrada velha deve sumir do Map.
    const fresh = putTx('{"fresh":true}');
    expect(getTx(stale)).toBeNull();
    expect(getTx(fresh)).toBe('{"fresh":true}');
  });
});
