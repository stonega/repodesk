# Telegram chat controls

Use an already deployed test bot with the updated app and worker. No live action
is performed by the automated checks. Use a disposable workspace/account for writes.

1. Open the private chat on desktop and mobile. After worker activation, the old
   repository/GitHub/Google/Ask/Status/Cancel/Help command entries should be absent.
   Restarting the worker or rotating its token should not restore those entries.
2. Say “What can you do?” in your own language. Help should describe conversational
   requests. Send an ordinary greeting while optional integrations are unavailable;
   it should still answer.
3. Ask “Help me choose a repository”. Choose an item, reopen the picker, search by
   name and clear the selection. Verify a separate Topic/person keeps its own choice.
4. In a private Topic, ask “Connect my Google account”. Complete sign-in, verify the
   displayed identity and choose **Connect account**. Ask for account status,
   Search Console properties, reconnect and disconnect. Confirm each step changes
   only your account in the selected workspace.
5. Ask “Connect my GitHub account”, authorize and confirm in Telegram. Ask to refresh
   permissions, then disconnect. Try both account requests in a linked group: no
   authorization link should appear there.
6. Start work, then send “Please stop”. Verify it stops without creating another
   assistant run. Ask to check/stop prior work; with several candidates, verify the
   choices select the intended task and stay in the same Topic.
7. Ask to list/pause/resume/run/delete a named schedule. Ask to save an instruction,
   then replace or forget it. Verify saving still offers its approval controls.
   A new explicit daily/weekly schedule with time/timezone activates immediately.
8. Ask to show usage, settings and privacy. A regular member cannot change the
   workspace timezone, group collection or request workspace deletion. An authorized
   administrator's deletion request must still require confirmation.
9. With several memberships and no selected workspace, send a greeting and choose
   the workspace button. Later ask to switch workspaces by name. An account outside
   the selected workspace must not be able to use a copied selection control.
10. As an authorized administrator, ask in private to link a group. Open the returned
    link and select the intended group. Verify the bot confirms linking only when
    the sender is also a Telegram group administrator. The app does not need a
    manually typed linking command. The native payload follows
    [Telegram's documented deep-link behavior](https://core.telegram.org/bots/features#deep-linking).

Automated coverage:

```sh
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres \
  bun test tests/integration/telegram-chat-controls.test.ts \
    tests/unit/telegram-commands.test.ts tests/unit/telegram-router.test.ts
```

The test database must be disposable and allow database creation. Tests use fake
transports and do not verify real-model intent selection or Telegram client layout.
