import { TOOLS } from "../src/domain.ts";
import { detailLabel } from "./data-details.tsx";
import type { FormField } from "./record-form.tsx";
export function workflowFields(
  skills: { id: string; draft: { name: string } }[],
  repositories: { id: number; full_name: string }[] = [],
): FormField[] {
  return [
    { path: "name", label: "Workflow name", required: true, maxLength: 80 },
    {
      path: "task",
      label: "Task",
      kind: "textarea",
      required: true,
      maxLength: 2000,
    },
    {
      path: "chatId",
      label: "Destination chat ID",
      required: true,
      help: "Use a linked group ID or your verified Telegram ID.",
    },
    {
      path: "topicId",
      label: "Topic ID",
      kind: "number",
      min: 0,
      step: 1,
      required: true,
      help: "Use 0 when the chat has no topic.",
    },
    {
      path: "recurrence.frequency",
      label: "Repeat",
      kind: "select",
      required: true,
      options: [
        { value: "daily", label: "Daily" },
        { value: "weekly", label: "Weekly" },
      ],
    },
    {
      path: "recurrence.weekday",
      label: "Day of week",
      kind: "select",
      required: true,
      numeric: true,
      when: { path: "recurrence.frequency", value: "weekly" },
      options: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ].map((label, i) => ({ label, value: String(i + 1) })),
    },
    {
      path: "recurrence.hour",
      label: "Hour (0–23)",
      kind: "number",
      min: 0,
      max: 23,
      step: 1,
      required: true,
    },
    {
      path: "recurrence.minute",
      label: "Minute (0–59)",
      kind: "number",
      min: 0,
      max: 59,
      step: 1,
      required: true,
    },
    {
      path: "recurrence.timezone",
      label: "Timezone",
      required: true,
      help: "IANA timezone, for example Asia/Taipei.",
    },
    {
      path: "format",
      label: "Response format",
      kind: "textarea",
      maxLength: 2000,
    },
    {
      path: "budgetUsd",
      label: "Budget per run (USD)",
      kind: "number",
      required: true,
      min: 0.001,
      max: 5,
      step: "any",
    },
    {
      path: "skillId",
      label: "Skill",
      kind: "select",
      required: true,
      options: skills.map((s) => ({ value: s.id, label: s.draft.name })),
    },
    {
      path: "windowDays",
      label: "History window (days)",
      kind: "number",
      min: 1,
      max: 30,
      step: 1,
      required: true,
    },
    ...(repositories.length
      ? [
          {
            path: "repositoryIds",
            label: "Repository sources",
            kind: "choices" as const,
            numeric: true,
            help: "Optional, up to six repositories. Private repository reports to a group require an admin's approval.",
            options: repositories.map((repo) => ({
              value: String(repo.id),
              label: repo.full_name,
            })),
          },
        ]
      : []),
  ];
}
export const skillFields: FormField[] = [
  {
    path: "slug",
    label: "Skill slug",
    required: true,
    maxLength: 50,
    help: "Lowercase letters, numbers and hyphens; start with a letter.",
  },
  { path: "name", label: "Skill name", required: true, maxLength: 80 },
  { path: "description", label: "Description", required: true, maxLength: 300 },
  {
    path: "body",
    label: "Instructions",
    kind: "textarea",
    required: true,
    maxLength: 12000,
  },
  {
    path: "tools",
    label: "Requested tools",
    kind: "choices",
    options: TOOLS.map((value) => ({ value, label: detailLabel(value) })),
  },
  {
    path: "settings.sections",
    label: "Output sections",
    kind: "textarea",
    maxLength: 1000,
  },
  {
    path: "settings.maxWords",
    label: "Maximum words",
    kind: "number",
    min: 50,
    max: 1000,
    step: 1,
    required: true,
  },
];
export const instructionFields: FormField[] = [
  {
    path: "body",
    label: "Instruction",
    kind: "textarea",
    required: true,
    maxLength: 4000,
  },
  {
    path: "scope",
    label: "Applies to",
    kind: "select",
    required: true,
    options: [
      { value: "workspace", label: "Entire workspace" },
      { value: "personal", label: "My private conversations" },
      { value: "workflow", label: "One workflow" },
    ],
  },
  {
    path: "workflowId",
    label: "Workflow ID",
    required: true,
    when: { path: "scope", value: "workflow" },
  },
];
export const runFields: FormField[] = [
  {
    path: "task",
    label: "Task",
    kind: "textarea",
    required: true,
    maxLength: 4000,
  },
  { path: "chatId", label: "Destination chat ID", required: true },
  {
    path: "topicId",
    label: "Topic ID",
    kind: "number",
    min: 0,
    step: 1,
    required: true,
  },
];
export const chargeFields: FormField[] = [
  {
    path: "actualUsd",
    label: "Verified charge (USD)",
    kind: "number",
    required: true,
    min: 0,
    max: 100,
    step: "any",
  },
  {
    path: "reference",
    label: "Billing reference",
    required: true,
    minLength: 3,
    maxLength: 100,
  },
];
export const deliveryFields: FormField[] = [
  {
    path: "remoteId",
    label: "Telegram message ID",
    kind: "number",
    required: true,
    min: 1,
    step: 1,
  },
];
export const accountFields: FormField[] = [
  {
    path: "username",
    label: "Username",
    required: true,
    minLength: 3,
    maxLength: 64,
  },
  {
    path: "password",
    label: "Password",
    kind: "password",
    required: true,
    minLength: 12,
    maxLength: 256,
    help: "At least 12 characters.",
  },
];
export function workspaceOptions(
  workspaces: { id: string; settings: { name: string }; deleted: boolean }[],
): FormField {
  return {
    path: "workspaceId",
    label: "Workspace",
    kind: "select",
    required: true,
    options: workspaces
      .filter((w) => !w.deleted)
      .map((w) => ({ value: w.id, label: w.settings.name })),
  };
}
