import { Temporal } from "@js-temporal/polyfill";
import {
  type Recurrence,
  recurrenceSchema,
  type WorkflowSpec,
} from "../domain.ts";
/** Previous complete local calendar days, including 23/25-hour DST days. */
export function repositoryReportWindow(
  at: string,
  spec: Pick<WorkflowSpec, "recurrence" | "windowDays">,
) {
  const date = Temporal.Instant.from(at)
    .toZonedDateTimeISO(spec.recurrence.timezone)
    .toPlainDate();
  return {
    since: date
      .subtract({ days: spec.windowDays })
      .toZonedDateTime(spec.recurrence.timezone)
      .toInstant()
      .toString(),
    until: date
      .toZonedDateTime(spec.recurrence.timezone)
      .toInstant()
      .toString(),
  };
}
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
