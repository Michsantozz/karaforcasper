/**
 * Next.js instrumentation hook — runs ONCE when the server process boots
 * (before the first request), on the Node runtime only.
 *
 * We use it to fail-fast on invalid environment configuration: a missing or
 * malformed secret crashes the boot with a readable report, instead of
 * surfacing later as a cryptic runtime error the first time some code path
 * touches the var.
 *
 * `next build` sets NEXT_PHASE=phase-production-build and imports route modules
 * to collect page data WITHOUT a real env (see the Proxy note in shared/db) —
 * so we skip validation during the build phase. It runs on real server boot
 * (`next start` / the container) where the env is present.
 */
export async function register() {
  // Only the Node.js server runtime has process.env fully populated; the edge
  // runtime instrumentation call would validate against an empty env.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Skip during `next build` — route imports run without the runtime env.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { validateEnv } = await import("@/shared/lib/env-schema");
  validateEnv();

  // Fail-fast in production if OAuth-token encryption has no key (would store
  // Google tokens in plaintext). Warns-only in dev/test. Throws → crashes boot.
  const { assertTokenEncryptionKey } = await import(
    "@/server/crypto/token-cipher"
  );
  assertTokenEncryptionKey();

  // Defense-in-depth RLS check — warns (never blocks) if the DB connection can
  // bypass row-level security (owner/BYPASSRLS role). Best-effort, non-fatal.
  const { assertRlsHardening } = await import("@/shared/db/rls");
  await assertRlsHardening().catch(() => {});
}
