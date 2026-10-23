export function GroupMentionGuide() {
  return (
    <section
      className="card group-mention-guide"
      aria-labelledby="group-mention-heading"
    >
      <h2 id="group-mention-heading">Group @mentions</h2>
      <p>
        The bot can stay a regular group member. Telegram privacy mode can stop
        plain @mentions from reaching it, even when commands and replies work.
      </p>
      <ol>
        <li>
          Open <a href="https://t.me/BotFather">@BotFather</a> and send{" "}
          <code>/setprivacy</code>.
        </li>
        <li>
          Select your bot and choose <strong>Disable</strong>.
        </li>
        <li>
          Remove the bot from the Telegram group, then add it again. This makes
          the saved RepoDesk group link inactive; re-adding the bot alone does
          not restore it.
        </li>
        <li>
          Choose <strong>New</strong> on this page and send the new{" "}
          <code>/link</code> command in the group as an active workspace member
          who is also a Telegram group administrator. Wait for{" "}
          <strong>Group linked</strong>, then choose{" "}
          <strong>Recheck bot visibility</strong> and try{" "}
          <code>@your_bot hi</code>, replacing <code>your_bot</code> with your
          bot’s username.
        </li>
      </ol>
      <p>
        Alternatively, make the bot a group administrator to receive group
        messages without changing privacy mode. Administrator access is
        optional.
      </p>
      <p className="muted">
        Linking enables message collection by default; you can turn it off in
        Group access. Message collection is not required for @mentions. While
        privacy mode is enabled, use <code>/ask@your_bot hi</code> or reply to a
        bot message.{" "}
        <a href="https://core.telegram.org/bots/features#privacy-mode">
          Telegram privacy-mode guide
        </a>
      </p>
    </section>
  );
}
