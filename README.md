# CasperAgent

Agente autônomo de IA na **Casper Network (Testnet)** — submissão para o **Casper Agentic Buildathon 2026**.

Um agente que **percebe → decide → age** on-chain: consulta a carteira, avalia o estado e executa transações reais de CSPR no Testnet, via chat ou em loop autônomo agendado.

---

## O que faz

- **Chat agêntico**: converse com o agente; ele consulta saldos e transfere CSPR sob comando.
- **Transações reais on-chain**: cada transferência é uma `Transaction` nativa assinada e submetida ao Casper Testnet (componente exigido pelo buildathon).
- **Loop autônomo**: workflow em cron (Inngest) onde o agente avalia o estado e decide sozinho se age — sem humano no loop.

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend / chat | Next.js 16 + assistant-ui (streaming AI SDK v6) |
| Orquestração de agente | Mastra (`Agent` + `tools` + `Workflow`) |
| LLM | AWS Bedrock — `claude-sonnet-4-6` |
| Blockchain | `casper-js-sdk` v5 (Testnet) |
| Loop autônomo | Inngest (cron workflow) |

## Arquitetura

```
chat / cron
   │
   ▼
Mastra Agent (Bedrock) ── tools ──► get_agent_wallet · get_balance · transfer_cspr
   │                                                          │
   ▼                                                          ▼
assistant-ui (UI + ToolUI)                    casper-js-sdk → RpcClient.putTransaction()
                                                              │
                                                              ▼
                                                   Casper Testnet (tx real)
```

Arquivos-chave:
- `src/lib/casper/` — client RPC, signer, transfer on-chain
- `src/mastra/tools/casper.tool.ts` — tools que o LLM chama
- `src/mastra/agents/casper.agent.ts` — o agente
- `src/mastra/workflows/autonomous.workflow.ts` — loop autônomo (cron)
- `src/app/api/chat/route.ts` — endpoint de chat (streaming)
- `src/components/Assistant.tsx` — UI do chat + render da tx

---

## Setup

### 1. Dependências

```bash
pnpm install
```

### 2. Variáveis de ambiente

```bash
cp .env.example .env.local
```

Preencha em `.env.local`:
- `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — credenciais Bedrock
- `CASPER_NODE_URL` / `CASPER_CHAIN_NAME` — já vêm com defaults de Testnet

### 3. Gerar a carteira do agente

```bash
pnpm tsx scripts/gen-key.ts
```

Isso cria `agent-secret.pem` (a carteira que assina as tx) e imprime a **public key**.

### 4. Fundar no faucet do Testnet

Copie a public key impressa e funde em:
**https://testnet.cspr.live/tools/faucet**

Sem fundos, o agente não consegue pagar gas das transações.

### 5. Rodar

```bash
pnpm dev                # app em http://localhost:3000
pnpm dev:inngest        # (opcional) loop autônomo local
```

---

## Walkthrough (demo)

1. Abra `http://localhost:3000`.
2. Pergunte: *"Qual o saldo da sua carteira?"* → o agente chama `get_agent_wallet`.
3. Peça: *"Transfira 2.5 CSPR para `<pubkey>`"* → o agente chama `transfer_cspr`, assina e submete a tx.
4. A UI mostra o **transactionHash** e um link para o explorer (`testnet.cspr.live`).
5. Confirme a transação no explorer — ela existe on-chain.

---

## Segurança

- `agent-secret.pem` e `.env.local` estão no `.gitignore` — **nunca** são commitados.
- Em produção, use um secret manager (não arquivo local).
- O loop autônomo move fundos sem confirmação humana — ajuste a política no prompt do agente antes de usar com valores reais.

---

## Buildathon

- **Componente on-chain gerando transações**: ✅ `transfer_cspr` (Native Transfer no Testnet)
- **Agentic AI**: ✅ agente percebe/decide/age, em chat e em cron autônomo
- **Repo público + README**: este documento
- Detalhes do hackathon e ideias de evolução: ver histórico do projeto
