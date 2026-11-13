# RepoDesk plugin template (preview)

Copy this entire directory into a new GitHub repository. No RepoDesk checkout or
published npm package is required. `.repodesk/` contains the versioned preview SDK,
manifest schema and bundled CLI. Read its third-party notices before redistribution.

1. Install Bun **1.3.14** and run `bun install --frozen-lockfile`.
2. In `repodesk.plugin.json`, set your repository URL, publisher, ID, name and
   description. Keep `package.json` and manifest versions equal.
3. Run `bun run generate`, then implement the generated handler in `src/index.ts`.
4. Run `bun run check`, `bun run typecheck`, `bun test`, `bun run build`,
   `bun run validate` and `bun run example`.
5. Commit source, `src/generated`, `dist/plugin.mjs`, README and LICENSE. Create
   an immutable stable `v0.1.0` tag and push the repository and tag yourself.
6. In RepoDesk's Plugins page, add a GitHub source, review the exact commit and
   capabilities, install disabled, configure, then enable it explicitly.

The example command executes **trusted local code with your developer account's
permissions** and fixture responses; it provides no OS isolation. Installation
never runs this command, package scripts or a dependency installer. Production
executes only the committed bundle in a restricted, networkless Node container.

Only `schemaVersion: 1`, preview `apiVersion: "1"`, Node ESM, computation,
`github.metadata.read` and approved `http.read` are supported. The host validates
the manifest and all input/settings/output. It assigns tool names using numeric
GitHub identity (`rdp_<repositoryId>_<localName>`). Never hard-code that prefix.

Import only `@repodesk/plugin-sdk`; use `context.github.getRepository` or
`context.http.request` for declared reads. GitHub requires the invoking member's
current repository access. HTTP requires reviewed exact origins/paths/query keys
and an explicit member/destination connection. Tokens stay on the host. A declared
capability is a ceiling and does not grant permission. Direct network, app files,
credentials, writes, timers, background callbacks and interactive Pi UI are unavailable.

The machine schema is `.repodesk/sdk/plugin/manifest.schema.json`; use `validate`
for semantic and linked-resource checks too. Keep results bounded and respect
`context.signal`. Use fixed declared diagnostic codes rather than private input.
The first profile has a 30-second invocation limit and a 5 MiB bundle limit.

Companion guides may declare `skills/<slug>/SKILL.md` with `name`, `description`
and optional `allowed-tools` containing only this plugin's local tool names or
`load_guide`. Relative Markdown/text links stay within that guide directory. The
host exposes an authorized `load_guide` tool and rewrites declared tool references.
Guides provide instructions, never permission.

Rebuild and re-review after SDK upgrades. API 1 is a preview compatibility profile;
stable npm/CLI and official GitHub template publication are separate release gates.
