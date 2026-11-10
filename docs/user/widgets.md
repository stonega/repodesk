# Interactive Telegram widgets

In a private conversation with RepoDesk, ask for an interactive chart, comparison
or calculator. The **Telegram widgets** preset is enabled by default in **Skills**;
admins can inspect its instructions or disable it.

For example:

> Make an interactive estimate for 3 seats at USD 10 each, with buttons to change
> the seat count. Treat it as a local preview; do not make a purchase.

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
