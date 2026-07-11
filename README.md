# Casper Agent

**Casper Agent is an AI meeting assistant that schedules recording bots, captures your calls, and turns them into actionable minutes — all through chat.**

Teams lose meeting outcomes across scattered notes and chats. Casper Agent brings the whole loop into one conversational assistant: it sends recording bots to Zoom/Meet/Teams calls, transcribes and summarizes them, pushes the minutes to you when they're ready, and answers questions across your entire meeting history.

Built for the **Casper Agentic Buildathon 2026**, the project demonstrates an autonomous AI agent connected to real meeting infrastructure (Recall.ai), a connected calendar (Google/Outlook), and durable background workflows.

## Demo

- App: https://casper.careglyph.com
- Repo: https://github.com/Michsantozz/karaforcasper

## What It Does

- **Send a bot to any meeting**: schedule a recording bot for a Zoom/Google Meet/Teams call — now or in the future — and control it live (start/stop/pause recording, screenshare, chat, audio/video output).
- **Schedule from chat**: "schedule a meeting Thursday at 2pm" creates the Google Calendar event, generates the Meet link, and attaches the recording bot in one shot. A calendar picker in the chat only offers free slots.
- **Automatic minutes ("push")**: when the transcript is ready, a webhook fires the minutes generation (summary + decisions + action items + topics + participants), and the bot owner gets an in-app notification linking to the notebook — no need to come back and ask.
- **Meeting notebook**: a player/karaoke view syncing the recording, timestamped transcript, decisions, action items, moments, and soundbites.
- **Cross-meeting search**: ask about your meeting history without naming a bot — `list_my_meetings` and `search_my_meetings` find past meetings by keyword/topic and cite which meeting the answer came from.
- **Multimodal chat**: attach images/PDFs; the vision model reads them inline.
- **Multi-thread chat**: a sidebar of persistent conversations, each backed by the agent's own memory.
- **Multi-tenant & secure**: every meeting, thread, and upload is scoped to the authenticated user (Postgres RLS + ownership checks). Webhooks are Svix-signed and fail-closed.

## How It Works

The agent is a single Mastra agent (`assistantAgent`) exposing meeting and calendar tools over an assistant-ui chat. Reads come from the Recall.ai MCP (read-only) and REST; writes (create/schedule/control bots) go through app tools with per-user deduplication in Postgres.

### 1. Schedule a meeting with a recording bot (most common flow)

1. The agent calls `pick_date` — a calendar with clickable free slots renders in the chat.
2. It calls `create_calendar_event` with the chosen time, `withMeet=true`, `sendBot=true`.
3. Google Calendar event + Meet link + recording bot are created in one call.

### 2. After the meeting (automatic minutes)

1. Recall fires the `transcript.done` webhook (Svix-verified) to `/api/webhooks/recall/bot`.
2. The record is enqueued (idempotent) and enrichment runs: `summarizeMeeting` produces summary, decisions, action items, topics, participants, soundbites.
3. The minutes persist to `meeting_records`; the owner gets an in-app notification.
4. A reconcile cron (Inngest) reprocesses anything that failed — the webhook never has to redeliver.

### 3. During a live meeting

Control the bot from chat: `start/stop/pause/resume_recording`, `send_chat_message`, `start/stop_screenshare`, `output_audio` (mp3 alerts), `output_video` (image), `remove_bot`.

### 4. Cross-meeting questions

"What did we decide about X?" → `search_my_meetings` returns matching meetings + transcript snippets, scoped to the user's own records only.

## Tech Stack

| Layer | Technology |
|---|---|
| App | Next.js 16, React 19, App Router + RSC |
| Agent framework | Mastra (agents, tools, workflows) |
| LLM | Fireworks AI (default, vision-capable) or AWS Bedrock |
| Meeting infrastructure | Recall.ai (REST + MCP), Google Calendar OAuth |
| Chat UI | assistant-ui, Tailwind / shadcn-style components |
| Auth | better-auth |
| Database | Postgres, Drizzle ORM (RLS multi-tenant) |
| Background workflows | Inngest (crons, reconcile loop) |
| Object storage | S3 / MinIO (chat image + file attachments) |
| Email | Resend (transactional "minutes ready") |

## Project Structure

```txt
src/
├── app/                   # Next.js routes and route handlers (thin shells)
├── features/
│   ├── assistant/         # Main AI chat UI + thread store
│   ├── auth/              # Session and app shell
│   ├── meetings/          # Recall/calendar UI, meeting notebook, clips
│   └── notifications/     # In-app notification bell
├── mastra/
│   ├── agents/            # assistantAgent (the meeting assistant)
│   ├── tools/             # recall, calendar tools
│   └── workflows/         # auto-schedule, meeting-reconcile
├── server/
│   ├── recall/            # Recall.ai, calendar, OAuth, meeting records
│   └── storage/           # S3 upload
└── shared/                # DB (schema, RLS), UI primitives, utils
```

## Key Files

- `src/mastra/agents/assistant.agent.ts` — the meeting assistant, its tools and instructions.
- `src/mastra/tools/recall.tool.ts` — send/control bots, transcript, summarize, cross-meeting search.
- `src/mastra/tools/calendar.tool.ts` — list events, schedule bots, create meetings, free-slot lookup.
- `src/server/recall/summarize.ts` — turns a transcript into structured minutes.
- `src/server/recall/enrich.ts` — durable enrichment run after a meeting.
- `src/app/api/webhooks/recall/bot/route.ts` — Svix-verified webhook that triggers the minutes push.
- `src/app/api/chat/route.ts` — chat entrypoint (auth + ownership + memory binding).
- `src/features/assistant/model/threads.ts` — per-user chat thread store (Mastra memory).

## Local Setup

### 1. Install

```bash
pnpm install
```

Requires **Node >= 24** and **pnpm** (enforced via `only-allow pnpm`).

### 2. Environment

```bash
cp .env.example .env.local
```

Required groups (see `.env.example` for the full annotated list):

- **Database**: `DATABASE_URL` (Postgres — better-auth + Mastra memory + Drizzle).
- **Auth**: `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`.
- **LLM**: `MODEL_PROVIDER` (`fireworks` default | `bedrock`). For Fireworks: `FIREWORKS_API_KEY`, `FIREWORKS_MODEL_ID`. For Bedrock: `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, AWS credentials.
- **Meetings**: `RECALL_API_KEY`, `RECALL_REGION`, `RECALL_WEBHOOK_SECRET` (Svix `whsec_...`).
- **Calendar OAuth**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `OAUTH_STATE_SECRET`.
- **Object storage** (chat attachments): `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` (MinIO defaults ship in docker-compose).
- **Multi-instance**: `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (stable across replicas).
- **Email** (optional): `RESEND_API_KEY`, `EMAIL_FROM` — without it, email is a no-op (in-app bell only).

### 3. Database

```bash
pnpm db:migrate
```

### 4. Recall webhooks

Configure two endpoints in the Recall dashboard (same Svix secret):

- Calendar events → `{APP_URL}/api/webhooks/recall`
- Bot / transcript → `{APP_URL}/api/webhooks/recall/bot` (subscribe to `transcript.done` — this is what generates the minutes and notifies the owner)

### 5. Run

```bash
pnpm dev
```

The autonomous workflows need the Inngest dev server:

```bash
pnpm dev:inngest   # inngest-cli dev -u http://localhost:3000/api/inngest
```

Production-style local run:

```bash
pnpm build
pnpm start
```

Or the full self-host stack (Postgres + MinIO + Inngest + app):

```bash
cp .env.example .env   # fill the [SECRET] values
docker compose up -d --build
```

## Commands

```bash
pnpm dev                 # local dev server
pnpm dev:inngest         # Inngest dev server (autonomous workflows)
pnpm build               # production build
pnpm start               # run the built app
pnpm typecheck           # TypeScript check
pnpm lint                # ESLint (includes architecture boundary rules)
pnpm test                # Vitest
pnpm test:unit           # unit tests
pnpm test:component      # component tests
pnpm test:e2e            # Playwright tests
pnpm db:migrate          # Drizzle migrations
pnpm db:studio           # Drizzle Studio
```

## Tests

Most tests are hermetic by default (mocked Recall/Bedrock/DB). Live external flows and E2E are opt-in.

```bash
pnpm test:unit
pnpm test:component
pnpm test:integration
RUN_LIVE_E2E=1 pnpm test:e2e:live
```

Live tests consume external API credits (Recall, LLM).

## Security Notes

- Every route is auth-gated; user ids come from the session, never from the request body.
- Meetings, chat threads, and uploads are scoped per user via Postgres RLS (`withUserScope`) and explicit ownership checks (`assertBotOwner`) — cross-tenant reads 404, they never leak.
- Webhooks are Svix-signed (HMAC-SHA256, timing-safe, anti-replay) and **fail-closed**: no secret configured → 500, invalid signature → 401.
- Chat `meetingBotId` is honored only if the caller owns the bot; a forged id is silently ignored.
- Uploads are MIME-allowlisted, size-capped (10 MB), and stored under a user-namespaced key.
- `.env*` and `*.pem` are gitignored; production deployments should use a secret manager.

## Architecture

The codebase uses a **feature-based architecture colocated with the App Router**, with layer boundaries enforced by ESLint (`eslint-plugin-boundaries`). `app/` owns routing only; business logic lives in `features/<domain>/`; server-only code (Recall, storage) lives in `server/`; generic UI/DB/utils in `shared/`. See `CLAUDE.md` for the full boundary rules.

## Buildathon Fit

- **AI Agent**: one assistant plans and calls tools across meetings and calendar, with persistent memory.
- **Autonomy**: durable Inngest workflows schedule bots and reconcile minutes without a human in the loop.
- **Real infrastructure**: live Recall.ai bots on real Zoom/Meet/Teams calls, real Google Calendar OAuth.
- **Multimodal**: image/PDF attachments read by a vision model in chat.
