import { currencies } from "../src/currency.ts";
import type { Settings } from "../src/domain.ts";

interface WorkspaceField {
  key: keyof Settings;
  label: string;
  help: string;
  min?: number;
  max?: number;
  step?: number | "any";
  options?: readonly string[];
}

export const currencyField: WorkspaceField = {
  key: "currency",
  label: "Team currency",
  help: "Choose the default currency for assistant responses. Budgets and usage accounting use USD; amounts are not automatically converted.",
  options: currencies,
};

export const workspaceFields: WorkspaceField[] = [
  { key: "name", label: "Workspace name", help: "1–80 characters." },
  {
    key: "timezone",
    label: "Timezone",
    help: "IANA timezone, for example Asia/Taipei.",
  },
  {
    key: "runBudgetUsd",
    label: "Run budget (USD)",
    help: "Maximum estimated spend per run. Leave blank for None (no limit). 0 permits only zero-cost requests.",
    min: 0,
    step: "any",
  },
  {
    key: "monthlyBudgetUsd",
    label: "Monthly budget (USD)",
    help: "Total workspace spend per UTC month. Leave blank for None (no limit). Any configured run and monthly budgets apply.",
    min: 0,
    step: "any",
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
