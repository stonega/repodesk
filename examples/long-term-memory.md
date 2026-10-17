# Long-term memory from Telegram

Implemented locally. These examples use ordinary bot-addressed requests; they do
not require commands, new accounts or changes to Telegram collection settings.

## Private recall

1. In a private Topic, ask: `记住：在 RepoDesk 项目里，我希望回答简短，涉及设计权衡时再展开。`
2. In another private Topic for the same workspace and bot, ask:
   `我之前对 RepoDesk 的回答风格有什么要求？`
3. Ask `列出你为我保存的记忆。`, then `忘记刚才那条回答风格的记忆。`
   The model selects the exact visible memory ID before requesting deletion.
4. `关闭记忆` disables personal recall and background generation; `开启记忆`
   restores eligible recall. Another member's private history stays inaccessible.

## Shared group recall

1. Address the bot in a linked group Topic:
   `记住：我（101）建议这个项目每周检查备份，团队尚未确认。`
2. Another active workspace member addresses the bot in the same group/Topic:
   `之前是谁建议检查备份？团队确认了吗？`
   The record identifies the speaker and preserves the proposal's status.
3. A different Topic, group, bot or private chat cannot retrieve that group record.
4. The original speaker can ask the bot to forget their note. Another ordinary
   participant cannot delete it; a workspace owner/admin can. Mixed-speaker
   automatically extracted records also require an owner/admin to forget.
5. An owner/admin can ask `关闭记忆` or `开启记忆` in that group Topic. This
   affects that shared Topic, not personal scopes or other Topics.

## Automatic recall and limits

After a successful directed conversation has been idle for 30 minutes, the worker
can extract useful historical context and consolidate its scope's recall index.
This consumes the original request's remaining dollar budget and uses its pinned
model. A later request can therefore recall a decision without an explicit save.
Active/failed conversations and arbitrary uncollected group traffic do not qualify.

The generated index is historical context, not approval or a permanent instruction.
For example, remembering `直接发布` never grants GitHub write or deployment rights.
Forgetting a memory prevents its automatic re-extraction from those retained
sources; it does not erase the original conversation. Expiration, source edits and
workspace deletion also invalidate recall.

Run deterministic checks with an isolated test database:

```sh
bun test tests/unit/long-term-memory.test.ts
TEST_DATABASE_URL=postgres://localhost/isolated_tests bun test tests/integration/long-term-memory.test.ts --timeout 30000
```

See [implementation and visibility rules](../docs/design/long-term-memory.md).
