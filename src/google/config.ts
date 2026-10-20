import { z } from "zod";

export const googlePlugins = [
  "google-docs",
  "google-sheets",
  "google-drive",
  "gmail",
] as const;
export type GooglePlugin = (typeof googlePlugins)[number];
export const googlePlugin = z.enum(googlePlugins);
export const googleDefinitions = {
  "google-docs": {
    name: "Google Docs",
    scope: "https://www.googleapis.com/auth/documents.readonly",
    tool: "query_google_docs",
    summary: "Read documents, including document tabs.",
  },
  "google-sheets": {
    name: "Google Sheets",
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    tool: "query_google_sheets",
    summary: "Read spreadsheet details and cell ranges.",
  },
  "google-drive": {
    name: "Google Drive",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    tool: "query_google_drive",
    summary: "Find files and read file details.",
  },
  gmail: {
    name: "Gmail",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    tool: "query_gmail",
    summary: "Search mail and read messages.",
  },
} as const;
export interface GoogleConnection {
  id: string;
  account: string;
  subject: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  reconnectRequired?: boolean;
  refresh?: { id: string; at: string };
}
export interface GoogleConfig {
  settings: { enabled: boolean };
  clientId: string;
  clientSecret: string;
  connection?: GoogleConnection;
  flow?: {
    stateHash: string;
    sessionHash: string;
    adminId: string;
    revision: number;
    redirectUri: string;
    verifier: string;
    expiresAt: string;
    exchanging?: boolean;
  };
}
export interface GooglePage {
  revision: number;
  settings: { enabled: boolean };
  clientId: string;
  clientSecretConfigured: boolean;
  redirectUri: string;
  scope: string;
  status: "not_connected" | "connected" | "refreshing" | "reconnect_required";
  account?: string;
}
export const googleSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: z.object({ enabled: z.boolean() }).strict(),
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/)
      .max(256)
      .optional(),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export const googleRevision = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const pageToken = z.string().min(1).max(2048).optional();
export const docsQuery = z.object({ documentId: id }).strict();
export const sheetsQuery = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("spreadsheet"), spreadsheetId: id }).strict(),
  z
    .object({
      resource: z.literal("values"),
      spreadsheetId: id,
      range: z.string().min(1).max(256),
    })
    .strict(),
]);
export const driveQuery = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("files"),
      query: z.string().trim().min(1).max(200).optional(),
      pageToken,
    })
    .strict(),
  z.object({ resource: z.literal("file"), fileId: id }).strict(),
]);
export const gmailQuery = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("messages"),
      query: z.string().trim().min(1).max(500).optional(),
      pageToken,
    })
    .strict(),
  z.object({ resource: z.literal("message"), messageId: id }).strict(),
]);
export const googleQueries = {
  "google-docs": docsQuery,
  "google-sheets": sheetsQuery,
  "google-drive": driveQuery,
  gmail: gmailQuery,
};
