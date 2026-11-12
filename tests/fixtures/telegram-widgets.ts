import { telegramWidgetSpec } from "../../src/skills/telegram-widgets.ts";

/** Original November 10 preset, before proactive presentation guidance. */
export function originalTelegramWidgetSpec() {
  return {
    ...telegramWidgetSpec(),
    description:
      "Create interactive charts, comparisons and calculators inside private Telegram messages.",
    body: "Read [the rendering guide](references/rendering.md) with load_skill and this skill's id before creating a widget. Follow its limits and example; send HTML and a useful caption with send_telegram_widget.",
  };
}
