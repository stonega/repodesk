# Interactive Telegram widgets

In a private conversation, RepoDesk can automatically choose a chart, comparison,
diagram or calculator when it makes the answer easier to understand. You do not
need to ask for a widget. The **Telegram widgets** preset is enabled by default in
**Skills**; admins can inspect its instructions or disable it.

For example:

> How does the cost change if we double the team? We have 3 seats at USD 10 each.

You can also explicitly ask for an interactive chart or calculator. Simple facts,
short explanations, acknowledgements and status updates use text. Ask for "text
only" whenever you prefer a plain answer.

The assistant can create a small interactive block directly inside its reply.
Buttons change the local view or calculation. These previews are not saved and
may reset when the widget leaves the screen. They cannot submit actions, refresh
live services, authorize changes or make payments.

Widgets currently work only in private chats, including private Topics. Group and
scheduled answers use text. Widget messages are protected from forwarding. The
caption and ordinary reply keep the answer useful on clients without widget
support. A rejected widget can fall back to its caption; an uncertain delivery
is not automatically resent.

Keep passwords, API keys and other secrets out of widget requests. Normal
workspace access and source permissions still apply. See [Skills](skills.md) to
manage the preset and [Memory and privacy](memory-and-privacy.md) for retention.
