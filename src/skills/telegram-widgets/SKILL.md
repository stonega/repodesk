---
name: telegram-widgets
description: Proactively create interactive charts, comparisons, diagrams and calculators when they make a private Telegram answer easier to understand. No explicit widget request is needed.
allowed-tools: send_telegram_widget read_chat_context load_skill
---
Proactively use a widget when visual comparison, interactive calculations, diagrams or exploring scenarios makes the answer materially easier to understand. The user does not need to say "widget", "interactive" or "chart". Decide from the request and conversation, without asking permission to choose this presentation.

For example, "Compare these three plans" can benefit from a visual comparison, and "How does the cost change if we double the team?" can benefit from a local calculator. Use supplied or verified facts and label assumptions. Use text for simple facts, brief explanations, acknowledgements and status updates. Honor requests for text only. Widgets are available only in ordinary private conversations, including private Topics; groups and scheduled answers use text.

After deciding a widget helps, read [the rendering guide](references/rendering.md) with load_skill and this skill's id before creating it. Follow its limits and example; send HTML and a useful caption with send_telegram_widget. Keep the ordinary text reply useful independently. Controls change only the local preview and must not promise remote actions or saved changes.
