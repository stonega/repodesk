# Native reaction staging scenario

Use a dedicated staging bot with an active deployment, an enabled chat model and
an active workspace member. This scenario sends real Telegram messages when run
manually; deterministic tests use fake Telegram and model transports instead.

1. In a private chat, send `Please react to this message with a heart and say hello.`
   Expect one native heart reaction on that user message and a normal bot reply.
   An emoji-only text message is not a reaction.
2. In a linked group Topic, send
   `/ask Please react to this message with 👍 and say hello.`
   Expect the reaction on the requester's message in that Topic and a final reply
   in the same Topic. Check both desktop and mobile Telegram clients.
3. Continue a casual conversation, including thanks or a confirmed small win.
   Reactions may fit some turns; they should remain occasional and should not
   appear on every message. Ask the bot to skip reactions and check that it
   respects that request within the conversation.
4. Disable reactions or the chosen emoji in the staging group, then repeat step 2.
   Expect the ordinary reply to remain available even if Telegram rejects the
   reaction. No fallback emoji text should appear.
5. Run a scheduled report. It should deliver normally without reacting to an old
   message. Reactions never approve a proposal or establish task completion.

The model selects reactions, so frequency and tone need a real-model staging pass.
Permission revocation, duplicate ingress/tool calls, bot changes, deleted sources,
rate limits and interrupted delivery are covered deterministically in
`tests/unit/telegram-reactions.test.ts` and
`tests/integration/telegram-reactions.test.ts`.
