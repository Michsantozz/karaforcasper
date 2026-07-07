import { describe, expect, it } from "vitest";
import {
  hashMeetingRecord,
  hashToTransferId,
  decodeOptionU64LE,
  type MeetingRecord,
} from "@/server/casper/meeting-notary";

// hashMeetingRecord é a âncora de proof-of-existence on-chain: mesma ata (mesmo
// conteúdo lógico) DEVE produzir o mesmo SHA-256 independente da ordem de campos
// e da ordem dos arrays — senão a verificação posterior (verifyMeeting recalcula
// o hash) falha silenciosamente. Estes testes fixam essa invariante.

const HEX64 = /^[0-9a-f]{64}$/;

const base: MeetingRecord = {
  botId: "bot-123",
  summary: "Reunião de planejamento Q3",
  decisions: ["adotar OKRs", "contratar 2 devs"],
  actionItems: [
    { task: "escrever RFC", owner: "ana" },
    { task: "orçar infra", owner: "bruno" },
  ],
  participants: ["ana", "bruno", "caio"],
  topics: ["roadmap", "orçamento"],
};

describe("hashMeetingRecord — formato", () => {
  it("produz um SHA-256 hex de 64 chars", () => {
    expect(hashMeetingRecord(base)).toMatch(HEX64);
  });
});

describe("hashMeetingRecord — determinismo", () => {
  it("mesma ata → mesmo hash (chamadas repetidas)", () => {
    expect(hashMeetingRecord(base)).toBe(hashMeetingRecord(base));
  });

  it("independe da ordem de inserção das chaves do objeto", () => {
    const reordered: MeetingRecord = {
      topics: base.topics,
      summary: base.summary,
      participants: base.participants,
      actionItems: base.actionItems,
      decisions: base.decisions,
      botId: base.botId,
    };
    expect(hashMeetingRecord(reordered)).toBe(hashMeetingRecord(base));
  });

  it("independe da ordem dos arrays decisions/participants/topics", () => {
    const shuffled: MeetingRecord = {
      ...base,
      decisions: ["contratar 2 devs", "adotar OKRs"],
      participants: ["caio", "ana", "bruno"],
      topics: ["orçamento", "roadmap"],
    };
    expect(hashMeetingRecord(shuffled)).toBe(hashMeetingRecord(base));
  });

  it("independe da ordem dos actionItems (ordenados por task)", () => {
    const shuffled: MeetingRecord = {
      ...base,
      actionItems: [
        { task: "orçar infra", owner: "bruno" },
        { task: "escrever RFC", owner: "ana" },
      ],
    };
    expect(hashMeetingRecord(shuffled)).toBe(hashMeetingRecord(base));
  });
});

describe("hashMeetingRecord — normalização de campos opcionais", () => {
  it("campos omitidos e arrays vazios explícitos geram o mesmo hash", () => {
    const omitted: MeetingRecord = { botId: "b", summary: null };
    const empty: MeetingRecord = {
      botId: "b",
      summary: null,
      decisions: [],
      actionItems: [],
      participants: [],
      topics: [],
    };
    expect(hashMeetingRecord(omitted)).toBe(hashMeetingRecord(empty));
  });

  it("summary null e summary omitido normalizam igual (→ \"\")", () => {
    const nullSummary: MeetingRecord = { botId: "b", summary: null };
    const emptySummary: MeetingRecord = { botId: "b", summary: "" };
    expect(hashMeetingRecord(nullSummary)).toBe(hashMeetingRecord(emptySummary));
  });

  it("actionItem owner null normaliza igual a owner \"\"", () => {
    const nullOwner: MeetingRecord = {
      botId: "b",
      summary: null,
      actionItems: [{ task: "t", owner: null }],
    };
    const emptyOwner: MeetingRecord = {
      botId: "b",
      summary: null,
      actionItems: [{ task: "t", owner: "" }],
    };
    expect(hashMeetingRecord(nullOwner)).toBe(hashMeetingRecord(emptyOwner));
  });
});

describe("hashMeetingRecord — sensibilidade a mudança real", () => {
  it("atas diferentes produzem hashes diferentes", () => {
    const other: MeetingRecord = { ...base, summary: "outro resumo" };
    expect(hashMeetingRecord(other)).not.toBe(hashMeetingRecord(base));
  });

  it("botId diferente muda o hash", () => {
    expect(hashMeetingRecord({ ...base, botId: "bot-999" })).not.toBe(
      hashMeetingRecord(base),
    );
  });

  it("preserva unicode no summary de forma estável", () => {
    const uni: MeetingRecord = { botId: "b", summary: "café ☕ 日本語 — ok" };
    expect(hashMeetingRecord(uni)).toBe(hashMeetingRecord(uni));
    expect(hashMeetingRecord(uni)).toMatch(HEX64);
  });
});

describe("hashToTransferId", () => {
  it("deriva um número dos primeiros 13 hex do hash", () => {
    // 13 chars "1" em hex = 0x1111111111111 = 300239975158545.
    expect(hashToTransferId("1111111111111ffffff")).toBe(0x1111111111111);
  });

  it("é determinístico (mesmo hash → mesmo id)", () => {
    const h = hashMeetingRecord({ botId: "b", summary: "x" });
    expect(hashToTransferId(h)).toBe(hashToTransferId(h));
  });

  it("nunca excede Number.MAX_SAFE_INTEGER (13 hex ≈ 52 bits)", () => {
    // maior valor possível: 13 F's = 0xfffffffffffff.
    const max = hashToTransferId("fffffffffffff0000000");
    expect(max).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(max)).toBe(true);
  });
});

describe("decodeOptionU64LE", () => {
  it("prefixo 00 (Option::None) → null", () => {
    expect(decodeOptionU64LE("00")).toBeNull();
    expect(decodeOptionU64LE("00e803000000000000")).toBeNull();
  });

  it("string vazia/falsy → null", () => {
    expect(decodeOptionU64LE("")).toBeNull();
  });

  it("decodifica 01 + u64 little-endian corretamente (vetor: 1000)", () => {
    // 1000 = 0x03e8 → LE 8 bytes = e8 03 00 00 00 00 00 00 → prefixo 01.
    expect(decodeOptionU64LE("01e803000000000000")).toBe(1000);
  });

  it("decodifica 1 (LE 0100000000000000)", () => {
    expect(decodeOptionU64LE("010100000000000000")).toBe(1);
  });

  it("prefixo 01 (Some) sem bytes → null (dado truncado/malformado swallow)", () => {
    // "01" sem u64: le = "", "".match(/.{2}/g) === null → retorna null.
    // Comportamento fail-safe: resposta corrompida vira "não encontrado", não crash.
    expect(decodeOptionU64LE("01")).toBeNull();
  });
});
