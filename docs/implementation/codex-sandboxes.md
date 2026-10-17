# Alternative Codex sandboxes and benchmarks

RepoDesk supports deployment-selected `docker` and `opensandbox`
execution through the same task supervisor. Operators can also choose a runtime
in **Plugins → Codex → Runtime → Edit**. This is a deployment-wide setting, separate
from workspace workflow settings. Workspace settings and
the application runner HTTP protocol remain the same; the historical payload
value `backend: "podman"` names that local runner protocol, not its selected engine.
Podman and microsandbox execution support have been removed; the old wire value
remains only for persisted approval/protocol compatibility. The shipped VPS
overlay continues to select Docker. This change does not switch
or deploy an existing installation.

## Admin-panel selection

The saved panel selection takes precedence over `CODEX_CONTAINER_ENGINE`. Choose
**Follow environment variable** to remove the override. The trusted supervisor
stores only the selected engine and revision in its private state volume, in
`runtime-selection.json` (mode 600). A restart loads that choice before tasks.
Retain the state volume when redeploying. Host credentials are never returned by
the runtime API or copied into task environments.

Selection changes are operator-only, with session, Origin and CSRF enforcement;
the supervisor separately requires its management token. Revision checks reject
concurrent edits. A changed engine is probed before saving, and a failed probe
leaves the current selection unchanged. A lost save response is uncertain: read
the current selection before retrying. The management operation never replays tasks.

Switching the effective engine requires every retained task record to be cleaned,
including completed work, questions/auth pauses, unknown outcomes and checkpoints.
Finishing a task alone may retain its checkout for follow-ups. Wait for configured
retention/normal erasure, or use an isolated runner for benchmarks. Changing the
configuration source while keeping the same engine does not interrupt tasks.
Do not delete live state to force a switch.

The panel selects prepared host profiles; it does not start a sandbox server,
mount sockets or import images. Existing environment-only configuration
continues to work. Optional per-engine image/socket settings allow one supervisor
to prepare multiple backends:

```dotenv
CODEX_CONTAINER_ENGINE=docker
CODEX_DOCKER_IMAGE=localhost/deepx-codex-job:local
CODEX_OPENSANDBOX_IMAGE=localhost/repodesk-codex-opensandbox:local
CODEX_DOCKER_HOST=unix:///var/run/docker.sock
```

The environment default retains the legacy `CODEX_RUNNER_IMAGE`/`CONTAINER_HOST`
fallback. The Docker profile uses its configured socket.
Selecting OpenSandbox from another default requires its explicit compatible image.
Alternate sandbox profiles append the engine name to configured shared storage
roots, so the OpenSandbox server's allowed-host-path prefix must include that
subdirectory. Both host and supervisor paths must still refer to the same data.
Prepare the proxy address for every intended backend before enabling switching.
A successful connection probe is not an end-to-end model/publication validation.

## Execution contract

Every prepare/setup/implement/check/export/publish phase receives a fresh execution
environment. Work storage persists across the first five phases; publication gets
separate storage and the verified patch. Inputs are mounted read-only, and export
also gets read-only work storage and denied network access. Only implementation
receives the temporary model proxy token or a separate writable account credential
mount. Only checkout/publication receive their respective GitHub tokens.
Setup and checks receive neither credential. Completed sandboxes are destroyed
before a subsequent phase starts. No background implementation process can survive
into verification. Managed account refresh ordering remains unchanged.

Sandbox IDs and background job IDs persist across supervisor restarts. Environment
reservations are encrypted with the runner management key and removed before launch.
Uncertain create/command responses never trigger automatic replacement or replay.
Cancellation and retention remove sandboxes and task storage; failed cleanup remains
retryable. Metadata files are bounded regular files, read without following symlinks.

The first adapters retain the existing phase boundaries and polling. They do not
yet implement prewarmed pools, memory snapshots or cross-task dependency caches.
Benchmark results describe this implementation, not each upstream runtime's best
possible startup time. Live Codex/account and publication validation are separate
from the credential-free benchmark.

## OpenSandbox

The pinned TypeScript SDK and companion server are **1.1.1**. Start a dedicated
self-hosted server using a private copy of
[the example configuration](../../deploy/codex/opensandbox.example.toml). Create
its state directory first, replace the example API key, keep the configuration
mode 600 and permit only the dedicated sandbox storage prefix. The server and
Docker daemon must see that storage at the configured host path.

Build `docker build --target codex-opensandbox-job -t localhost/repodesk-codex-opensandbox:local .`
for this backend. Its trusted execd starts as root so Linux can switch command
identity; every repository command explicitly runs as UID/GID 1000. Using the
ordinary `USER node` image makes execd's UID transition fail with `EPERM`.
The example pins matching `release-1.1.1` execd/egress images.

Use `dns+nft` egress enforcement, the capability restrictions, process limits,
loopback endpoint publication and management authentication shown in the example.
Keep task networks separate from the application/database network. The Docker
runtime does not support `secureAccess`; its execd ports must remain private.
On Kubernetes, set `OPENSANDBOX_SECURE_ACCESS=true` when using secured endpoints.

```dotenv
CODEX_CONTAINER_ENGINE=opensandbox
CODEX_RUNNER_TOKEN=the-existing-private-runner-management-token
CODEX_RUNNER_IMAGE=localhost/repodesk-codex-opensandbox:local
CODEX_RUNNER_STATE=/var/lib/repodesk-codex-opensandbox
CODEX_SANDBOX_ROOT=/var/lib/repodesk-sandboxes/opensandbox
OPENSANDBOX_URL=http://127.0.0.1:3021
OPENSANDBOX_API_KEY=the-private-server-key
OPENSANDBOX_SECURE_ACCESS=false
CODEX_RUNNER_PROXY_URL=http://runner.example.internal:3020
```

`CODEX_SANDBOX_HOST_ROOT` optionally maps the storage root to a different absolute
path on the OpenSandbox/Docker host. It must refer to the same files, not another
copy. The initial adapter requires shared host storage and a compatible preloaded
task image; it does not transfer checkouts between unrelated hosts.

On SELinux hosts, give a fresh dedicated storage root the shared container file
label before creating tasks, for example `chcon -t container_file_t
/var/lib/repodesk-sandboxes`. Newly created descendants inherit it. Do the same
for a fresh `SANDBOX_BENCHMARK_ROOT`. An unlabeled home-directory bind mount can
return `EACCES` despite matching UID 1000 permissions. Keep SELinux enabled; do
not relabel the workspace, server configuration or unrelated host directories.

Egress denies by default. `OPENSANDBOX_ALLOWED_DOMAINS` is a comma-separated
operator allowlist; defaults cover GitHub, npm, Debian and OpenAI endpoints. The
configured model proxy hostname is added. Add the package registries needed by
your repositories. Export has no allowed destinations. The management key is used
only by the supervisor SDK and is never included in task environment/input.
The proxy must have a DNS name resolvable inside the sandbox network; OpenSandbox's
domain policy does not support IP-literal destinations.

Browser tasks need a prepared image as well as network access. The landing-page
VPS test initially passed lint/types/unit/build but failed downloading Chromium
because `cdn.playwright.dev` was outside the allowlist. Prepare the repository's
pinned Playwright browser and native dependencies in a dedicated task image, using
`playwright install --with-deps chromium` and `PLAYWRIGHT_BROWSERS_PATH`; ensure UID
1000 can use the cache. Keep browser packages out of the ordinary minimal job image
unless the deployment needs them. A preinstalled browser avoids repeated downloads
and does not require broadening task egress. If a task must download browsers,
explicitly allow its required CDN/redirect domains. Both shipped Compose overlays
pass through `OPENSANDBOX_ALLOWED_DOMAINS` and `CODEX_RUNNER_PROXY_URL` overrides.
See [Playwright's custom image guidance](https://playwright.dev/docs/docker#build-your-own-image)
and the [VPS receipt](../research/sandbox-vps-2026-10-17.md).

For OpenSandbox, build with `bun run build`, then start with
`node dist/runner-server.js`. Connect the existing application worker to that
private authenticated runner endpoint. Use separate state roots when comparing
backends: retained tasks reject backend changes rather than operating on the
wrong engine. Drain/erase old tasks before a production migration.

## Repeatable benchmark

Build the dedicated fixture from the same trusted task image used by all engines:

```sh
docker build --target codex-job -t localhost/deepx-codex-job:local .
docker build -f deploy/codex/benchmark.Dockerfile \
  -t localhost/repodesk-sandbox-benchmark:local .
```

The fixture executes local Git operations, writes 100 source files and a roughly
one-MiB change, verifies it, exports the patch and simulates publication in fresh
storage. It checks that credential-free phases have no task credentials. It makes
no model, GitHub, Telegram or dependency-download calls. The publication URL is
explicitly synthetic. No real task/provider/account credentials are used.

Set OpenSandbox's URL/key and configure its allowed storage prefix to include the
absolute benchmark root. Its helper images must also be preloaded to measure warm
image behavior fairly. Then run:

```sh
docker network create repodesk_sandbox_benchmark
SANDBOX_BENCHMARK_ENGINES=docker,opensandbox \
SANDBOX_BENCHMARK_ITERATIONS=10 \
SANDBOX_BENCHMARK_CONCURRENCY=1 \
CODEX_RUNNER_NETWORK=repodesk_sandbox_benchmark \
bun run benchmark:sandboxes
```

Create the benchmark network once and remove it when finished. With no network
setting, the harness defaults OCI phases to `none`; use the dedicated bridge for
comparison with normal network-enabled tasks.
Repeat with concurrency 4 to compare throughput. `CONTAINER_HOST` selects the
Docker socket. The fixed runner limits default to 2 CPUs / 4096 MiB.
`SANDBOX_BENCHMARK_IMAGE`, `SANDBOX_BENCHMARK_ROOT`,
`SANDBOX_BENCHMARK_OUTPUT`, `SANDBOX_BENCHMARK_POLL_MS` (default 25), and
`SANDBOX_BENCHMARK_TIMEOUT_MS` (default 180000) override the fixture, storage,
report path, polling interval and per-task loop deadline. Engine calls retain
their own timeouts. Use 5000ms polling to include the production polling cadence.

JSON reports contain host/SDK metadata, individual phase and runtime-operation
timings (including startup and file copies/reads), total task times, P50/P95 and
failures. Iteration zero is the first measured run, not a guaranteed cold start;
later iterations reuse image caches with fresh sandboxes. No host cache eviction
or snapshot restore is performed. A failed engine produces an explicit failure
and no fabricated timing. All attempts finish before cleanup begins; cleanup is
limited to this run's task identities. Failed cleanup preserves its state directory
for recovery and causes a nonzero exit. Successful runs erase private task storage
and keep the report in `node_modules/.cache/sandbox-benchmark/results.json`.

Measure live model time, network clones, dependency installation and user follow-up
latency separately before selecting a production backend. The fixture benchmark
cannot establish those costs or live semantic correctness.

### Initial local smoke measurements (2026-10-17)

The same preloaded fixture image ran three times per backend, sequentially, with
2 CPUs / 4096 MiB limits, concurrency 1 and 25ms polling. Docker used a dedicated
bridge; OpenSandbox used its Docker runtime with the pinned execd/egress images.
The two supported backends below completed all six trials and erased their resources.

| Backend | Total P50 | Total P95 |
| --- | --- | --- |
| Docker | 4.24s | 4.52s |
| OpenSandbox | 18.44s | 18.64s |

These are small-sample smoke measurements of six fresh phase environments, not a
general ranking of the platforms or a live Codex benchmark. OpenSandbox's measured
phase startup/teardown dominates this fixture. Compare pooling/snapshot adapters
and production polling separately before drawing an end-to-end speed conclusion.
The local raw report is `node_modules/.cache/sandbox-benchmark/comparison-final.json`.

## Upstream references

- [OpenSandbox TypeScript SDK](https://github.com/opensandbox-group/OpenSandbox/tree/main/sdks/sandbox/javascript)
- [OpenSandbox server configuration](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)
