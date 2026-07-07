import "server-only";
import { requireEnv } from "@/mastra/env";

/**
 * Cliente REST mínimo para a API do Recall.ai.
 *
 * Auth: header `Authorization: Token <RECALL_API_KEY>`.
 * Base URL regional (RECALL_REGION) — recursos são region-local; use a mesma
 * região onde a conta/API key foi criada. Default: us-east-1.
 *
 * Regiões válidas: us-west-2 | us-east-1 | eu-central-1 | ap-northeast-1.
 */

const DEFAULT_REGION = "us-east-1";

function baseUrl(): string {
  const region = process.env.RECALL_REGION || DEFAULT_REGION;
  return `https://${region}.recall.ai`;
}

export class RecallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "RecallError";
  }
}

/** Indica esgotamento do pool de bots ad-hoc — retentável após ~30s. */
export class RecallAdhocPoolError extends RecallError {
  constructor(body: unknown) {
    super("Recall ad-hoc bot pool depleted (507). Retry in ~30s.", 507, body);
    this.name = "RecallAdhocPoolError";
  }
}

type RecallRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Caminho relativo a /api/, ex: "v1/bot/" ou "v1/bot/<id>/leave_call/". */
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
};

/** Executa uma requisição autenticada contra a REST API do Recall.ai. */
export async function recallFetch<T = unknown>(req: RecallRequest): Promise<T> {
  const apiKey = requireEnv("RECALL_API_KEY");

  const url = new URL(`${baseUrl()}/api/${req.path}`);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method: req.method,
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });

  // 204 / corpo vazio (ex: alguns DELETE) — retorna undefined.
  const text = await res.text();
  const parsed = text ? safeJson(text) : undefined;

  if (!res.ok) {
    if (res.status === 507) throw new RecallAdhocPoolError(parsed);
    throw new RecallError(
      `Recall API ${req.method} ${req.path} failed: ${res.status}`,
      res.status,
      parsed ?? text,
    );
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
