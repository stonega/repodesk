# Repository alerts example

An opt-in event producer for the RepoDesk preview SDK. The check_stars tool reads
current GitHub repository metadata and returns a star_threshold candidate when
the requested count is observed. It cannot establish the historical crossing time.

Grant github.metadata.read and notifications.publish, then subscribe personally to
Star threshold observed. Invoke the tool from a private conversation. The host owns
permissions, stable event deduplication and private Telegram delivery; the plugin
receives no chat IDs or Telegram token. This example creates no background poller.

Build with the repository plugin CLI using Bun 1.3.14. Offline input.json and
fixtures.json are synthetic; run only trusted code with --allow-unsafe-import.
