import { Observability, MastraStorageExporter } from "@mastra/observability";

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
 * `listFeedback` / `getFeedbackAggregate`.
 *
 * `Observability` auto-applies a `SensitiveDataFilter` span output processor to
 * every instance, so transcript/PII text captured in spans is scrubbed before
 * export. We keep that default on.
 *
 * A ConsoleExporter is added in dev so traces are visible locally; in prod only
 * the storage exporter runs (quieter, and the traces are queryable in PG).
 */
export function createObservability(): Observability {
  return new Observability({
    configs: {
      default: {
        serviceName: "casper-assistant",
        exporters: [new MastraStorageExporter()],
      },
    },
  });
}
