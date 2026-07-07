import next from "eslint-config-next";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = [
  ...next,

  // ---- Arquitetura: fronteiras entre camadas (feature-based, App Router) ----
  // Regra de import unidirecional: app -> features/mastra -> server/shared.
  // Slices de features não cruzam entre si (exceto assistant, orquestrador do chat).
  // server (server-only) nunca é importado pela UI de features.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["src/**/*"],
      "boundaries/elements": [
        { type: "app", pattern: "src/app/**/*" },
        { type: "mastra", pattern: "src/mastra/**/*" },
        { type: "server", pattern: "src/server/**/*" },
        // captura o nome do slice (multisig, wallet, ...) em "family"
        { type: "feature", pattern: "src/features/*/**/*", capture: ["family"] },
        { type: "shared", pattern: "src/shared/**/*" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        2,
        {
          default: "disallow",
          policies: [
            // app (rotas + route handlers) pode puxar tudo abaixo
            {
              from: { type: "app" },
              allow: { to: { type: ["feature", "mastra", "server", "shared"] } },
            },
            // mastra (server-side) pode puxar lógica de negócio server + shared + sessão (auth)
            {
              from: { type: "mastra" },
              allow: {
                to: [
                  { type: ["mastra", "server", "shared"] },
                  { type: "feature", captured: { family: "auth" } },
                ],
              },
            },
            // server-only pode compor com server + shared
            {
              from: { type: "server" },
              allow: { to: { type: ["server", "shared"] } },
            },
            // o slice "assistant" orquestra o chat: pode consumir outros slices (tool-UIs)
            {
              from: { type: "feature", captured: { family: "assistant" } },
              allow: { to: { type: ["shared", "feature"] } },
            },
            // wallet mostra contexto da tx multisig durante o fluxo de assinatura
            {
              from: { type: "feature", captured: { family: "wallet" } },
              allow: {
                to: { type: "feature", captured: { family: "multisig" } },
              },
            },
            // auth é cross-cutting e roda server-side (config do better-auth): pode
            // tocar server para enviar e-mail de verificação/reset/magic-link.
            {
              from: { type: "feature", captured: { family: "auth" } },
              allow: { to: { type: ["shared", "server"] } },
            },
            // demais slices: shared + auth (transversal, sessão) + o próprio slice
            {
              from: { type: "feature" },
              allow: {
                to: [
                  { type: "shared" },
                  { type: "feature", captured: { family: "auth" } },
                  { type: "feature", captured: { family: "{{ from.captured.family }}" } },
                ],
              },
            },
            // shared é folha: só depende de shared
            {
              from: { type: "shared" },
              allow: { to: { type: "shared" } },
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
