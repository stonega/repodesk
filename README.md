# DeepX Agent for Telegram

A team assistant with bounded Pi requests, source-aware recaps, approved recurring
workflows, shared instructions, and a web admin panel.

**Status:** local P0 implementation, 2026-09-18. Automated tests use fake Telegram/model
transports and real PostgreSQL. Live model evaluation and staging deployment remain
release gates; no bot or paid account is connected by installation.

## Start here

- [Setup and Docker](docs/implementation/setup.md)
- [Implementation evidence and limits](docs/implementation/implementation-status.md)
- [Telegram commands and admin guide](docs/user/telegram-experience.md)
- [Architecture](docs/design/architecture.md)
- [LLM plugins / Pi extensions](docs/design/llm-extensions.md)
- [Release and recovery runbook](docs/implementation/release-runbook.md)
- [Original implementation plan](docs/implementation/bot-plan.md)
- [Product requirements and research](docs/README.md)

```sh
bun install --frozen-lockfile
bun install --cwd services/code-truth --frozen-lockfile
cp .env.example .env
# Set a unique POSTGRES_PASSWORD in .env.
mkdir -p secrets
openssl rand -hex 32 > secrets/encryption-key
docker compose up --build -d
docker compose exec app node dist/operator.js claim
```

Open `http://localhost:3000`, enter the one-use claim token, and create your admin.
The resumable wizard accepts write-only encrypted bot/model credentials. Webhook
registration and activation are explicit actions after HTTPS and staging credentials
are ready. The database is private; Compose exposes only the API on loopback.

```sh
bun run check
bun run typecheck
bun test
bun run build
bun run test:runtime
```

Set `TEST_DATABASE_URL` to run PostgreSQL integration tests and `bun run test:browser`.
See Setup for prerequisites. Normal checks never call live Telegram or model APIs.

## Stack

TypeScript strict, Bun packages/build/tests, Biome, Hono on Node 24, React Router 7,
Pi 0.85.1, PostgreSQL 17 and pg-boss. API and worker share one Docker image and durable
configuration. The local pilot uses transactionally locked workspace aggregates;
read the architecture's capacity limits before scaling.

Plugins are Pi extensions. Open **Workspace → Plugins** to register installed files,
edit tools, and enable/disable or remove plugins for the selected workspace. Settings
and revisions are independent per workspace and reach workers without restart; `PI_EXTENSIONS_FILE` remains an optional
fallback. See the compatibility guide above; extensions are off by default.

No shell, arbitrary browsing, executable skills, app connectors, files, payments or
external write tools are exposed. Group context collection requires separate consent.
Inspired by Every Agent; independent branding and a Telegram-specific permission model.

Predefined **Code Truth** adds read-only source queries and its companion skill. Configure each workspace’s repositories under **Workspace → Plugins**. See [local Code Truth setup](docs/implementation/code-truth.md).

Connect private repositories through **Workspace → Plugins → GitHub** using a GitHub App.
See [App registration and deployment setup](docs/implementation/github-app.md).
