# RepoDesk plugin SDK preview

This source-only authoring package provides `definePlugin` and TypeScript types.
Bundle it into a Node-targeted ESM plugin before execution. It has no runtime
dependencies and never receives host credentials, database objects or a Pi runtime.

The package is available locally in this repository; it has not been published to
npm. From an author package, install this directory with Bun or use the repository's
plugin CLI. Preview API `1` remains experimental. The offline harness is not an OS
sandbox and must only import trusted code.
