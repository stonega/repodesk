# Local setup and Docker

The current app is an HTTP scaffold. Pi, Telegram and the admin panel are planned in
[the implementation plan](bot-plan.md); no external credentials are required yet.

## Local development

Use Bun 1.3.14+ and Node.js 22.19+; Docker uses Node 24. Bun manages dependencies,
tests and compilation. Node runs Hono through `@hono/node-server`.

```sh
bun install --frozen-lockfile
bun run dev
```

The server listens at `http://localhost:3000`; set `PORT` to change it.

```sh
curl http://localhost:3000/
curl http://localhost:3000/healthz
```

The root identifies the scaffold; health returns `{"status":"ok"}`. The unimplemented
`POST /telegram/webhook` returns 404. Do not register it with Telegram yet.

## Quality and production build

```sh
bun run check
bun run typecheck
bun test
bun run build
bun run start
```

`build` bundles application TypeScript for Node into `dist/server.js`, keeping npm
dependencies external. `start` runs that artifact. `bun run format` applies Biome.

## Docker Compose

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
curl http://localhost:3000/healthz
docker compose down
```

For another host port: `APP_PORT=3100 docker compose up --build -d`.
Compose publishes only on loopback. The future production deployment needs an HTTPS
reverse proxy for Telegram webhooks and admin login.

The multi-stage Dockerfile uses the frozen Bun lockfile and copies production
dependencies plus compiled code into a Node 24 Debian image. It runs as `node`,
checks HTTP health, and supports SIGTERM/SIGINT shutdown. The allowlisted build
context excludes local secrets, Git history, docs, tests and CodeGraph state.
Pin tested base image digests in the first release pipeline.

Only `app` exists in Compose today. Add worker, PostgreSQL volume and migration job
with their implementation slices. Build admin static assets into the same app image
when the panel is implemented. No second browser-facing server is required.

## Future configuration

Add bot token, webhook secret and database connection string with transport work;
add provider credentials with Pi. The planned first-run wizard creates the admin and
accepts bot/provider credentials as encrypted write-only inputs. Inject the DB
connection and encryption key as deployment secrets at runtime, never through
Docker build arguments. The Node server does not automatically load `.env`, and this
Compose file does not inject one. Pass environment variables explicitly until the
configuration loader is implemented. Obtain the one-use first-admin claim token
through the planned local container command. Admin pages show credential status,
never stored secret values. See [first-run setup](../design/first-run-setup.md).

Persist PostgreSQL on a named volume. Document migrations, backups and restore before
pilot deployment. Avoid `docker compose down -v` where useful data exists.

## Repository state

Git is initialized on `main`; no commit or remote was created during bootstrap.
CodeGraph was initialized with authorization. Cloudflare configuration, Wrangler and
generated Worker declarations were removed when Docker was selected. No live bot,
model integration, database or admin panel is implemented yet.
