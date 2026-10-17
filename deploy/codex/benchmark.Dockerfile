# Build only for the local benchmark. It cannot execute real coding tasks.
ARG CODEX_BENCHMARK_BASE=localhost/deepx-codex-job:local
FROM ${CODEX_BENCHMARK_BASE}
USER root
COPY scripts/fixtures/sandbox-benchmark-job.mjs /opt/deepx/job.js
