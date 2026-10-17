# VPS sandbox verification — 2026-10-17

## Host and reproducible workload

Operator-authorized tests ran on the existing RepoDesk VPS (Ubuntu 24.04, Linux
6.8.0-146-generic, x86-64, four visible CPUs, approximately 8 GiB RAM). The
production runner remained Docker; OpenSandbox used a separate private test server,
private management key, storage prefix and controller. Application credentials
were not used by the infrastructure benchmark or repository preflight.

The infrastructure comparison used the repository's `benchmark:sandboxes` fixture:
local Git, file modifications, independent checks, patch export and simulated
publication through all six supervisor phases. It makes no live model, GitHub or
Telegram calls. A dedicated image derived from the VPS's existing task image was
shared by both successful runtimes; commands run as UID/GID 1000. Limits were two
CPUs / 2048 MiB, concurrency one, 25 ms poll and five trials per runtime. Images were
preloaded; these are not cold-start measurements.

An initial exploratory pass overlapped the authorized production Docker coding
request. Its timing is not the comparison reported below. A second pass began
after verifying no production Codex task container was running. The ordinary app,
worker, database and Actions runner services continued running on the host.

| Runtime | Successful trials | P50 | P95 | Outcome |
| --- | ---: | ---: | ---: | --- |
| Docker | 5 | 8.813 s | 10.373 s | Six-phase fixture passed |
| OpenSandbox 1.1.1, Docker backend | 5 | 23.783 s | 24.994 s | Six-phase fixture passed |
| microsandbox 0.7.8 | 0 | — | — | Host lacks usable KVM |

The final successful comparison had no failures. The separate three-engine
exploratory report records microsandbox's readiness failure explicitly. Five
trials describe this implementation/host; they do not establish broad performance
rankings or end-to-end agent latency. Model, dependency and GitHub time are separate.
No warm pool, snapshot or cross-task dependency cache was added by this test.

The operation breakdown identifies a useful next experiment: OpenSandbox phase
`start` had a 2.805 s median, including sandbox provisioning, versus Docker's
0.322 s start. The two operations wrap different backend work; do not compare
their names as identical SDK primitives. Six fresh phases accumulate that cost.
Measure a pool of unused prepared environments without reusing repository
processes or credentials across isolation boundaries before changing production.

Raw receipts are retained privately on the VPS under
`/opt/repodesk/acceptance/sandbox-comparison-20261017/`: `comparison.json` and
`comparison-idle.json`, together with scripts/configuration and bounded logs.
The final report was also copied into the ignored local
`node_modules/.cache/vps-sandboxes/comparison-idle.json`. No management key is
included in this document or the raw benchmark JSON. A checked-in
[measurement extract](data/sandbox-vps-2026-10-17.json) preserves all ten trial
times, phase timings, operation summaries and host/options metadata, omitting
private receipt paths and the verbose per-operation event stream.

## Landing-page workload

Repository: https://github.com/stonega/repodesk-landing.
Fixed initial source: `baseline-v1`, `d5fb0c64ef6c73da4b1af8805f5f077f00f5462f`.
The subsequent docs-only main commit `c3ac21835b95432421035b369dd13727c6f263e1`
was the base for the real Docker task and the isolated OpenSandbox model retest.

Both Docker and OpenSandbox completed a credential-free fresh clone, frozen Bun
install, Biome, strict TypeScript, three unit tests and production prerender build
of the fixed initial source at two CPUs / 2048 MiB. OpenSandbox's run completed in
14.732 seconds including its sandbox lifecycle. This is a repository preflight,
not an agent-optimization duration.

The real, Telegram-approved Docker task produced the ready-for-review
[PR #2](https://github.com/stonega/repodesk-landing/pull/2) at
`28f1acfef7df5074fb8fcb542e074ff6f8858f78`. Both GitHub Verify jobs and the native
Cloudflare Pages check passed. The successful preview's trigger is `github:push`:
https://51612f60.repodesk-landing.pages.dev. That verifies automatic PR previews;
the earlier connection gate is resolved, without attributing an unverified cause.

An isolated OpenSandbox model retest ran under an explicit host-operator
request, using the same approved repository/task scope and base. The existing
actor's GitHub access and current coding policy were rechecked through application
services; the operator action was audited. Scoped read/model credentials travel
through private stdin to the trusted controller, never logs/arguments or the
benchmark fixture. The model proxy binds only the Docker bridge's private address;
its guest DNS/network path was verified before the live run. Publication requires
fresh scoped authority and verified checks.

The first live attempt (`0903aa89-99ea-42ae-bb8e-28e129ebf6cf`) stopped in independent
verification with `coding_check_failed` after 370.203 s and created no PR. A
credential-free recheck of its generated checkout passed install, lint, types,
unit tests and build, then reproduced `ENOTFOUND cdn.playwright.dev` while installing
Chromium. Deny-default egress was working, but the test image had no prepared browser.
This is a failed acceptance sample, not a successful model-runtime timing.

A dedicated image now preinstalls the landing repository's pinned Playwright
1.64.1 Chromium and native dependencies, with a cache usable by UID 1000. This
changes the prepared environment for a separate retry; it does not alter either
reported fixture image or the production Docker job image.
The fixed `baseline-v1` has now passed a fresh credential-free clone/install,
lint/types/unit/build and the full browser suite in that image, at two CPUs / 2 GiB.
The browser suite had seven passing cases and one intentional desktop skip.

The private test root retains the exact `browser-job.Dockerfile`; its base is the
same original VPS job plus the root-USER OpenSandbox adaptation. The image is
`sha256:6222284f34fc1711495c2ad913198b36ee9ae5f78d176d0b0d11b2571569abd3`.
To reproduce the browser layer on a prepared compatible base:

```dockerfile
FROM localhost/repodesk-opensandbox-job:vps-20261017
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN BUN_INSTALL_CACHE_DIR=/tmp/repodesk-playwright-cache bun x --yes playwright@1.64.1 install --with-deps chromium \
    && chmod -R 777 /opt/playwright-browsers \
    && rm -rf /tmp/repodesk-playwright-cache /var/lib/apt/lists/*
```

The writable browser cache is in each fresh sandbox's image layer, not shared
between task identities. Commands still run as UID/GID 1000. The default production
image remains small; this prepared image is only for the landing acceptance task.

With that image, rechecking the first generated patch also exposed two browser
test failures (desktop/mobile): the case-insensitive `EXAMPLE REVIEW` text locator
matched both a response paragraph and its result label. Eleven browser cases
passed and one mobile-only case was skipped on desktop. The failed task was not
promoted or published. A separate retry receives these diagnostics and explicitly
requires the full browser suite; that extra feedback/preinstalled browser makes it
an acceptance repair attempt, not a controlled model-speed comparison.

The second attempt (`a740bf63-3738-4e56-973f-b5cc336dd32e`) passed independent frozen
install, lint, types, unit tests, build and browser verification. Its verification
plan explicitly exports `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers` for the
browser command, because job subprocesses deliberately receive a limited
environment. Image environment variables alone should not be assumed to pass
through that boundary. The model was `gpt-6.1-sol` with the runner's `high`
reasoning fallback, at two CPUs / 2048 MiB. Prepublication elapsed time was
514.546 s; token usage was not reported by this legacy issue-to-PR protocol.

Fresh repository-scoped publication authority was rechecked through the
application service and audited. The isolated supervisor published the
ready-for-review [PR #3](https://github.com/stonega/repodesk-landing/pull/3), head
`d5108b97a0f04a91d3cb7ce636a4352d33697e5d`. Both GitHub Verify jobs and native
Cloudflare Pages checks passed. Its automatic preview is
https://36cfc077.repodesk-landing.pages.dev. The deployed preview passed tab/keyboard,
Home/End, reduced-motion and overflow checks at 1440px and 390px; screenshots were
inspected. The PR is unmerged. The safe task receipt is `live-browser-receipt.json`
in the private test root; the verified patch is retained separately there.

After acceptance, both isolated live task environments were erased through their
supervisors. The dedicated OpenSandbox server was stopped after verifying its PID,
private virtualenv/config identity and loopback listener; its test storage and
benchmark bridge were removed. Temporary application handoff helpers were removed.
Private receipts, configuration (mode 600), pinned images and the Python environment
remain for reproduction. Production app/worker/Docker supervisor stayed healthy.

## microsandbox evaluated and removed from scope

The VPS has neither `/dev/kvm` nor exposed CPU `vmx`/`svm` flags. The experimental
driver failed its KVM readiness check before launching a microVM. Being hosted on a KVM
hypervisor does not itself expose nested KVM to its guest. The server cannot fix
this from inside the guest without the provider exposing virtualization.

The user then decided to drop microsandbox support. Its adapter, SDK dependency,
environment/profile settings, benchmark selection and admin option were removed.
This section preserves the failed prerequisite observation; it is not a supported
configuration or an outstanding request to change the VPS. The historical SDK
version in the measurement extract describes the test controller at measurement
time, not the current application's dependencies. See the
[official Linux troubleshooting requirements](https://docs.microsandbox.dev/troubleshooting/linux).
The OpenSandbox test server follows the [official self-hosted setup](https://open-sandbox.ai/getting-started)
with pinned server/SDK/helpers at 1.1.1 and `dns+nft` egress enforcement.

The user subsequently removed Podman support as well. Current runtime selections
are Docker and OpenSandbox only; the Docker adapter, local startup script, Compose
overlays and minimal supervisor image no longer require or invoke Podman. The
historical local-runner wire value is retained only for existing approval hashes
and stored task/protocol compatibility, not as an execution engine.
