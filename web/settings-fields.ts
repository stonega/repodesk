import type { Settings } from "../src/domain.ts";

export const workspaceFields: {
  key: keyof Settings;
  label: string;
  help: string;
  min?: number;
  max?: number;
  step?: number | "any";
}[] = [
  { key: "name", label: "Workspace name", help: "1–80 characters." },
  {
    key: "timezone",
    label: "Timezone",
    help: "IANA timezone, for example Asia/Taipei.",
  },
  {
    key: "runBudgetUsd",
    label: "Run budget (USD)",
    help: "Maximum estimated spend per run. No fixed dollar ceiling. 0 permits only zero-cost requests.",
    min: 0,
    step: "any",
  },
  {
    key: "monthlyBudgetUsd",
    label: "Monthly budget (USD)",
    help: "Total workspace spend per UTC month. Both run and monthly budgets apply.",
    min: 0,
    step: "any",
  },
  {
    key: "maxTurns",
    label: "Model calls per run",
    help: "1–20 calls. Runs also have a 90-second deadline and an eight-tool-call limit.",
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: "retentionDays",
    label: "Retention (days)",
    help: "1–90 days. This is the current storage retention policy.",
    min: 1,
    max: 90,
    step: 1,
  },
  {
    key: "missedRunMinutes",
    label: "Missed-run grace (minutes)",
    help: "Currently fixed at 5 minutes by the scheduling policy.",
    min: 5,
    max: 5,
    step: 1,
  },
];
