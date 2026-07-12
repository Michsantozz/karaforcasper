import {
  Observability,
  MastraStorageExporter,
  ConsoleExporter,
} from "@mastra/observability";
import type { ObservabilityExporter } from "@mastra/core/observability";
import { LangfuseExporter } from "@mastra/langfuse";

/**
 * Observability for the agent — traces, model-generation spans, and (crucially)
 * the human-feedback pipeline. Without this configured, `mastra.observability`
 * is the NoOp entrypoint: `addFeedback()` silently discards, so the 👍/👎 in the
 * chat would go nowhere.
 *
 * `MastraStorageExporter` persists spans + feedback into the app's PG (schema
 * `mastra`, same store as memory/workflows). It implements `onFeedbackEvent`,
 * which is what makes `mastra.observability.addFeedback(...)` durable — the
 * signal lands in the observability domain and can be read back via
 * `listFeedback` / `getFeedbackAggregate`. It also implements `onMetricEvent`,
 * so the token / cost / latency metrics Mastra auto-emits on every
 * MODEL_GENERATION span (mastra_model_total_input_tokens, estimatedCost,
 * mastra_{agent,tool,workflow}_duration_ms, …) already land in PG.
 *
 * `LangfuseExporter` (added only when LANGFUSE_* keys are set) forwards those
 * same spans + metrics to the Langfuse dashboard, so token spend, per-model
 * cost, and step/tool latency become navigable instead of trapped in PG. The
 * deps (`@mastra/langfuse`, `@langfuse/otel`) ship regardless; the export is a
 * pure env toggle — absent keys → PG only, no behavioural change.
 *
 * `Observability` auto-applies a `SensitiveDataFilter` span output processor to
 * every instance, so transcript/PII text captured in spans is scrubbed before
 * export. We keep that default on.
 *
 * A ConsoleExporter is added in dev so traces are visible locally; in prod only
 * the storage (+ optional Langfuse) exporter runs.
 */
export function createObservability(): Observability {
  const exporters: ObservabilityExporter[] = [new MastraStorageExporter()];

  // Ship traces + token/cost/latency to Langfuse when configured. env-schema
  // enforces both keys together, so checking one is enough here.
  if (process.env.LANGFUSE_PUBLIC_KEY) {
    exporters.push(
      new LangfuseExporter({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        environment: process.env.NODE_ENV,
      }),
    );
  }

  // Local visibility only — noisy in prod, and the traces are queryable in PG.
  if (process.env.NODE_ENV !== "production") {
    exporters.push(new ConsoleExporter());
  }

  return new Observability({
    configs: {
      default: {
        serviceName: "casper-assistant",
        exporters,
      },
    },
  });
}
