# CasperAgent

Agente autônomo de IA na **Casper Network (Testnet)** — nascido no **Casper Agentic Buildathon 2026** e evoluído para uma plataforma de agente com **multisig**, **reuniões** e **assinatura on-chain**.

O agente **percebe → decide → age** on-chain: consulta a carteira, avalia o estado e executa transações reais de CSPR no Testnet — via chat ou em loop autônomo agendado. Em volta dele, features de negócio orquestram carteiras multisig, notarização de reuniões (via Recall.ai) e fluxos de solicitação de assinatura.

---

## O que faz

- **Chat agêntico (gateado por login)** — converse com o agente; ele consulta saldos e transfere CSPR sob comando. O chat consome LLM e expõe tools on-chain, então exige sessão autenticada (o `/api/chat` também rejeita sem sessão — defesa em profundidade).
- **Transações reais on-chain** — cada transferência é uma `Transaction` nativa assinada e submetida ao Casper Testnet.
- **Loop autônomo** — workflow em cron (Inngest) onde o agente avalia o estado e decide sozinho se age, sem humano no loop.
- **Multisig** — criação/manutenção de carteiras multi-assinatura e coleta de assinaturas.
- **Reuniões** — bots do Recall.ai (Zoom/Meet/Teams) gravam reuniões; o agente pode notarizar/ancorar o resultado on-chain. Calendar V2 multi-usuário via OAuth Google.
- **Solicitações de assinatura** — fluxo de pedido → assinatura de um usuário (`/sign/[id]`).
- **Notificações** — entrega de eventos de domínio (webhooks Recall via Svix).

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend / chat | Next.js 16 (App Router + RSC) + assistant-ui (streaming AI SDK v6) |
| Orquestração de agente | Mastra (`Agent` + `tools` + `Workflow`) |
| LLM | AWS Bedrock — modelo via `BEDROCK_MODEL_ID` |
| Blockchain | `casper-js-sdk` v5 (Testnet) |
| Loop autônomo | Inngest (cron workflow) |
| Reuniões / calendário | Recall.ai (REST + MCP) |
| Persistência | Postgres + Drizzle ORM |
| Auth | better-auth |

---

## Arquitetura

Arquitetura **feature-based colocada com o App Router** — `app/` cuida só de rotas; toda a lógica vive em `features/`, `mastra/`, `server/`, `shared/`. A fronteira entre camadas é **imposta por ESLint** (`eslint-plugin-boundaries`): violar quebra `pnpm lint`. Ver [`CLAUDE.md`](./CLAUDE.md) para a diretriz completa.

```
src/
├── app/           # rotas apenas (pages + route handlers) — cascas finas que delegam
├── features/      # lógica de negócio por domínio (ui/ model/ [api/] + index.ts)
│   ├── assistant/     # orquestrador do chat (pode importar qualquer slice)
│   ├── auth/          # sessão (cross-cutting) + shell de navegação
│   ├── wallet/        # carteira do agente (pode importar multisig)
│   ├── multisig/      # carteiras multi-assinatura
│   └── meetings/      # reuniões Recall.ai + calendário
├── mastra/        # o agente: agents/ tools/ workflows/ (server-side)
├── server/        # server-only: casper/ (RPC, keys, tx, signature, notifications) · recall/ (bots, calendar)
└── shared/        # genérico, leaf: ui/ (shadcn + assistant-ui) · lib/ · db/
```

Cada slice de feature expõe uma API pública via `index.ts` (barrel) — importe pelo barrel, não fure para os internos de outro slice. **Signature** (solicitação de assinatura) e **notifications** vivem hoje como lógica server-only em `server/casper/` + route handlers em `app/api/`; ainda não têm slice de feature com UI própria.

Fluxo do agente:

```
chat / cron
   │
   ▼
Mastra Agent (Bedrock) ── tools ──► casper.tool · recall.tool · signature-request.tool · calendar.tool
   │                                        │
   ▼                                        ▼
assistant-ui (UI + ToolUI)      server/casper → RpcClient.putTransaction() → Casper Testnet (tx real)
```

### Arquivos-chave

- `src/server/casper/` — client RPC, signer, transfer, multisig, tx-store, transfer-policy
- `src/server/recall/` — bots, calendars, google-oauth
- `src/mastra/agents/` — `casper.agent.ts` · `assistant.agent.ts` · `meeting.agent.ts`
- `src/mastra/tools/` — tools que o LLM chama (casper, recall, calendar, signature-request, meeting-chain)
- `src/mastra/workflows/` — `autonomous.workflow.ts` (loop) · `multisig-maintenance.workflow.ts`
- `src/app/api/chat/route.ts` — endpoint de chat (streaming)
- `src/features/assistant/ui/Assistant.tsx` — UI do chat + render das tx

### Rotas

`/` (chat gateado) · `/multisig` · `/multisig/[id]` · `/sign/[id]` · `/meetings` · showcases (`/casper-showcase`, `/calendar-showcase`, `/wallet-test`).

### Leituras e escritas (RSC / client-server)

- **Leituras** — RSC e route handlers leem direto de `server/*`; UI client lê via hooks TanStack Query em `features/<domain>/model/` (nunca importa `server/`).
- **Escritas** — a maior parte passa por **route handlers** em `app/api/*` (o bridge que toca `server/*`): webhooks (Recall/Svix), callbacks OAuth e mutações chamadas pelo client via `fetch`. Server Actions são usadas onde a mutação pertence claramente a um slice. Ambos são idioma válido; a regra é: client nunca importa `server/` direto.

---

## Setup

### 1. Dependências

```bash
pnpm install     # pnpm é obrigatório (only-allow pnpm no preinstall)
```

### 2. Variáveis de ambiente

```bash
cp .env.example .env.local
```

Preencha em `.env.local`:

- **Bedrock (obrigatório)** — `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- **Casper** — `CASPER_NODE_URL` / `CASPER_CHAIN_NAME` (já vêm com defaults de Testnet)
- **Chave do agente** — `CASPER_AGENT_SECRET_KEY_PATH` (default `~/.casper/keys/agent-secret.pem`)
- **Postgres** — `DATABASE_URL` (Drizzle: dedup Recall, mapeamento user→calendar, auth)
- **Recall.ai (reuniões)** — `RECALL_API_KEY`, `RECALL_REGION`, `RECALL_WEBHOOK_SECRET` (Svix)
- **Calendar OAuth (Google)** — `OAUTH_STATE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`

### 3. Banco de dados

```bash
pnpm db:migrate     # aplica migrations Drizzle (alias de db:setup)
```

### 4. Gerar a carteira do agente

```bash
pnpm tsx scripts/gen-key.ts
```

Cria `~/.casper/keys/agent-secret.pem` (ED25519, `chmod 600`) e imprime a **public key**. Nunca mora na raiz do projeto; em prod use secret manager.

### 5. Fundar no faucet do Testnet

Copie a public key impressa e funde em **https://testnet.cspr.live/tools/faucet**. Sem fundos, o agente não paga gas.

### 6. Rodar

```bash
pnpm dev                # app em http://localhost:3000
pnpm dev:inngest        # (opcional) loop autônomo local
```

---

## Comandos

```bash
pnpm dev            # dev server
pnpm build          # build de produção (valida RSC/bundler)
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint (inclui regras de fronteira de arquitetura)
pnpm test           # vitest (unit + component, hermético)
pnpm db:migrate     # migrations drizzle
```

Antes de fechar qualquer mudança de código: rode `pnpm typecheck` **e** `pnpm lint`. Ambos devem passar.

---

## Testes

Hermético por padrão — unit/component rodam offline (MSW bloqueia rede). Integration e e2e são **opt-in** atrás de flags de env; alguns batem em serviços reais (Casper Testnet, Bedrock, Recall). Detalhes em [`tests/README.md`](./tests/README.md).

| Camada | Runner | Onde | Env |
|--------|--------|------|-----|
| unit | Vitest (node) | `tests/unit/**/*.test.ts(x)` | hermético |
| component | Vitest (jsdom) | `tests/component/**/*.test.tsx` | hermético |
| integration | Vitest (node, serial) | `tests/integration/**/*.integration.test.ts` | opt-in `RUN_LIVE_E2E=1` |
| e2e | Playwright | `tests/e2e/*.spec.ts` | opt-in `RUN_LIVE_E2E=1` |

```bash
pnpm test              # unit + component (hermético, rode a qualquer hora)
pnpm test:unit
pnpm test:component
pnpm test:integration                 # self-skip sem RUN_LIVE_E2E=1
RUN_LIVE_E2E=1 pnpm test:integration  # round-trip real na Testnet
pnpm exec playwright install chromium # uma vez
pnpm test:e2e                          # specs de UI herméticos
pnpm test:e2e:live                     # RUN_LIVE_E2E=1 — agente + tx reais
```

> E2E LIVE submete um Native Transfer real na Testnet e gasta gas em CSPR — a chave do agente precisa estar fundada.

---

## Segurança

- `~/.casper/keys/agent-secret.pem` e `.env.local` **nunca** são commitados (`.gitignore`).
- Em produção, use um secret manager (não arquivo local).
- O loop autônomo move fundos sem confirmação humana — ajuste a política (`transfer-policy.ts` + prompt do agente) antes de usar com valores reais.
- Não re-serialize um deploy/tx Casper após `setSignature` (o nó rejeita com -32016).
- Transferência mínima na rede: **2.5 CSPR** (abaixo disso o nó recusa com -32016).

---

## Buildathon

- **Componente on-chain gerando transações**: ✅ `transfer_cspr` (Native Transfer no Testnet)
- **Agentic AI**: ✅ agente percebe/decide/age, em chat e em cron autônomo
- **Repo público + README**: este documento
