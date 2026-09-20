import { Temporal } from "@js-temporal/polyfill";
import { type Recurrence, recurrenceSchema } from "../domain.ts";
/** One occurrence per local date; gaps are skipped and folds use the earlier instant. */
export function nextOccurrences(
  input: Recurrence,
  after: Date,
  count = 3,
): string[] {
  const rule = recurrenceSchema.parse(input);
  const start = Temporal.Instant.from(after.toISOString());
  let date = start.toZonedDateTimeISO(rule.timezone).toPlainDate();
  const result: string[] = [];
  for (
    let i = 0;
    i < 370 && result.length < count;
    i++, date = date.add({ days: 1 })
  ) {
    if (rule.frequency === "weekly" && date.dayOfWeek !== rule.weekday)
      continue;
    const local = date.toPlainDateTime({
      hour: rule.hour,
      minute: rule.minute,
    });
    const zoned = local.toZonedDateTime(rule.timezone, {
      disambiguation: "earlier",
    });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    if (Temporal.Instant.compare(zoned.toInstant(), start) > 0)
      result.push(zoned.toInstant().toString());
  }
  return result;
}
