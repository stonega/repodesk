# DeepX Agent for Telegram

A proposed team assistant that turns recurring work into reusable Telegram
workflows. Inspired by [Every Agent](https://agent.every.to/), with independent
branding and a Telegram-specific interaction and permission model.

**Status:** initialized on 2026-09-18. Product research and requirements are in
[`docs/`](docs/README.md). The code is a runnable HTTP backend scaffold with health
checks. Telegram messaging, AI, memory, automations, integrations, and billing are
planned, not implemented.

## Read first

- [Detailed Every Agent feature inventory](docs/research/every-agent-features.md)
- [Telegram product requirements and acceptance criteria](docs/design/product-requirements.md)
- [Telegram interaction design](docs/user/telegram-experience.md)
- [Architecture](docs/design/architecture.md)
- [Implementation roadmap](docs/implementation/roadmap.md)
- [Pi + Docker implementation plan](docs/implementation/bot-plan.md)
- [Setup](docs/implementation/setup.md)

## Development

Requires Bun 1.3.14+ and Node.js 22.19+ (Node 24 in Docker). Dependencies are locked in `bun.lock`.

```sh
bun install --frozen-lockfile
bun run dev
```

In another terminal:

```sh
curl http://localhost:3000/healthz
```

Expected: `{"status":"ok"}`. No Telegram token or model key is
needed for local development of this scaffold.

```sh
bun run check
bun run typecheck
bun test
bun run build
```

`build` produces `dist/server.js`; `bun run start` runs it under Node.
Use `bun run format` to format code. No bot webhook has been created.

## Docker

```sh
docker compose up --build -d
curl http://localhost:3000/healthz
docker compose down
```

Compose binds to localhost. Configure an HTTPS reverse proxy when the webhook is
implemented. The image runs as a non-root user, with health checks and graceful shutdown.

## Stack and layout

Bun manages dependencies and tests; TypeScript and Hono provide a small backend;
Node.js in Docker is the runtime target; Biome handles code quality. Pi is the
selected AI framework; PostgreSQL and pg-boss are planned for state and jobs.
These AI/storage dependencies are not installed yet.
Telegram is the team interface; a web admin panel is included in the first-release
plan and will be served by the same Docker app. Storage, Pi and the panel remain planned.

```text
src/                  HTTP backend scaffold
tests/                deterministic local tests
docs/design/          requirements and architecture
docs/research/        competitor features and evidence
docs/reference/       platform constraints and sources
docs/implementation/  setup and roadmap
docs/user/            proposed Telegram experience
examples/             runnable HTTP requests and workflow examples
scripts/              future repeatable automation
postmortem/           incident reports when needed
```
