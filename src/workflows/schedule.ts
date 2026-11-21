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

function inQuietHours(
  hour: number,
  quietStart?: number,
  quietEnd?: number,
): boolean {
  if (quietStart === undefined || quietEnd === undefined) return false;
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

/**
 * Computes next occurrence instants for once, daily, weekly, weekdays, monthly,
 * and interval recurrences. DST gaps are skipped and folds use the earlier instant.
 */
export function nextOccurrences(
  input: Recurrence,
  after: Date,
  count = 3,
): string[] {
  const rule = recurrenceSchema.parse(input);
  const start = Temporal.Instant.from(after.toISOString());

  if (rule.frequency === "once") {
    if (!rule.runAt) return [];
    const target = Temporal.Instant.from(rule.runAt);
    return Temporal.Instant.compare(target, start) > 0
      ? [target.toString()]
      : [];
  }

  if (rule.frequency === "interval") {
    const stepMs = (rule.intervalMinutes ?? 60) * 60_000;
    const result: string[] = [];
    let cursorMs = Math.ceil(after.getTime() / 60_000) * 60_000;
    if (cursorMs <= after.getTime()) cursorMs += stepMs;
    else cursorMs = after.getTime() + stepMs;
    for (
      let i = 0;
      i < 1000 && result.length < count;
      i++, cursorMs += stepMs
    ) {
      const instant = Temporal.Instant.fromEpochMilliseconds(cursorMs);
      const zoned = instant.toZonedDateTimeISO(rule.timezone);
      if (inQuietHours(zoned.hour, rule.quietStartHour, rule.quietEndHour)) {
        continue;
      }
      result.push(instant.toString());
    }
    return result;
  }

  const hour = rule.hour ?? 0;
  const minute = rule.minute ?? 0;
  let date = start.toZonedDateTimeISO(rule.timezone).toPlainDate();
  const result: string[] = [];
  const maxDays = rule.frequency === "monthly" ? 1200 : 370;

  for (
    let i = 0;
    i < maxDays && result.length < count;
    i++, date = date.add({ days: 1 })
  ) {
    if (rule.frequency === "weekly" && date.dayOfWeek !== rule.weekday) {
      continue;
    }
    if (rule.frequency === "weekdays" && date.dayOfWeek > 5) {
      continue;
    }
    if (rule.frequency === "monthly") {
      const targetDay =
        rule.dayOfMonth === "last" ? date.daysInMonth : rule.dayOfMonth;
      if (date.day !== targetDay) continue;
    }
    const local = date.toPlainDateTime({ hour, minute });
    const zoned = local.toZonedDateTime(rule.timezone, {
      disambiguation: "earlier",
    });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    if (Temporal.Instant.compare(zoned.toInstant(), start) > 0) {
      result.push(zoned.toInstant().toString());
    }
  }
  return result;
}
