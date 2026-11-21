# Telo plugin SDK preview

This source-only authoring package provides `definePlugin` and TypeScript types.
Bundle it into a Node-targeted ESM plugin before execution. It has no runtime
dependencies and never receives host credentials, database objects or a Pi runtime.

The package is available locally in this repository; it has not been published to
npm. From an author package, install this directory with Bun or use the repository's
plugin CLI. Preview API `1` remains experimental. The offline harness is not an OS
sandbox and must only import trusted code.

Optional notification producers declare `notifications.publish` on the package
and tool, plus named `notifications` events in the manifest. A successful tool may
return `ToolResult.notifications` candidates with stable IDs and event timestamps.
The host checks subscriptions and source grants and delivers only to the current
private actor. The plugin receives no messaging credentials or destination IDs.
This does not create a background poller. See the repository-alerts example and
the plugin development guide in the Telo distribution.
