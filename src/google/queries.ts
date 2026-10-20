import { requireThat } from "../domain.ts";
import { type GoogleClient, pick, row, rows } from "./client.ts";
import {
  docsQuery,
  driveQuery,
  type GooglePlugin,
  gmailQuery,
  sheetsQuery,
} from "./config.ts";

function documentText(contents: unknown, depth = 0): string {
  requireThat(depth < 32, "google_response_too_large", 502);
  return rows(contents)
    .map((item) => {
      if (item.paragraph)
        return rows(row(item.paragraph).elements)
          .map((e) => String(row(e.textRun).content ?? ""))
          .join("");
      if (item.table)
        return rows(row(item.table).tableRows)
          .map((r) =>
            rows(r.tableCells)
              .map((c) => documentText(c.content, depth + 1))
              .join("\t"),
          )
          .join("\n");
      if (item.tableOfContents)
        return documentText(row(item.tableOfContents).content, depth + 1);
      return "";
    })
    .join("");
}
function documentTabs(tabs: unknown, depth = 0): unknown[] {
  requireThat(depth < 32, "google_response_too_large", 502);
  return rows(tabs).flatMap((tab) => [
    {
      ...pick(tab.tabProperties, ["tabId", "title"]),
      text: documentText(row(row(tab.documentTab).body).content),
    },
    ...documentTabs(tab.childTabs, depth + 1),
  ]);
}
function plainParts(payload: unknown, depth = 0): string[] {
  requireThat(depth < 32, "google_response_too_large", 502);
  const p = row(payload);
  const body = row(p.body);
  const text =
    p.mimeType === "text/plain" && typeof body.data === "string"
      ? [Buffer.from(body.data, "base64url").toString("utf8")]
      : [];
  return [
    ...text,
    ...rows(p.parts).flatMap((part) => plainParts(part, depth + 1)),
  ];
}
export async function readGoogle(
  client: GoogleClient,
  plugin: GooglePlugin,
  input: unknown,
  token: string,
  guard: () => Promise<void>,
  signal?: AbortSignal,
) {
  const get = (url: URL) => client.get(url, token, guard, signal);
  switch (plugin) {
    case "google-docs": {
      const args = docsQuery.parse(input);
      const url = new URL(
        `https://docs.googleapis.com/v1/documents/${args.documentId}`,
      );
      url.searchParams.set("includeTabsContent", "true");
      const data = await get(url);
      requireThat(
        data.documentId === args.documentId,
        "google_invalid_response",
        502,
      );
      return {
        ...pick(data, ["documentId", "title"]),
        tabs:
          Array.isArray(data.tabs) && data.tabs.length
            ? documentTabs(data.tabs)
            : [{ text: documentText(row(data.body).content) }],
        contentIsUntrusted: true,
      };
    }
    case "google-sheets": {
      const args = sheetsQuery.parse(input);
      const url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}${args.resource === "values" ? `/values/${encodeURIComponent(args.range)}` : ""}`,
      );
      if (args.resource === "values") {
        url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
        const data = await get(url);
        requireThat(
          typeof data.range === "string",
          "google_invalid_response",
          502,
        );
        return {
          ...pick(data, ["range", "majorDimension", "values"]),
          contentIsUntrusted: true,
        };
      }
      url.searchParams.set(
        "fields",
        "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties))",
      );
      const data = await get(url);
      requireThat(
        data.spreadsheetId === args.spreadsheetId,
        "google_invalid_response",
        502,
      );
      return {
        ...pick(data, ["spreadsheetId", "spreadsheetUrl"]),
        properties: pick(data.properties, ["title", "locale", "timeZone"]),
        sheets: rows(data.sheets).map((s) =>
          pick(s.properties, ["sheetId", "title", "index", "gridProperties"]),
        ),
      };
    }
    case "google-drive": {
      const args = driveQuery.parse(input);
      const fields =
        "id,name,mimeType,webViewLink,modifiedTime,size,description,parents";
      const url = new URL(
        `https://www.googleapis.com/drive/v3/files${args.resource === "file" ? `/${args.fileId}` : ""}`,
      );
      url.searchParams.set("supportsAllDrives", "true");
      if (args.resource === "files") {
        const escaped = args.query
          ?.replaceAll("\\", "\\\\")
          .replaceAll("'", "\\'");
        url.searchParams.set(
          "q",
          `trashed = false${escaped ? ` and name contains '${escaped}'` : ""}`,
        );
        url.searchParams.set(
          "fields",
          `nextPageToken,incompleteSearch,files(${fields})`,
        );
        url.searchParams.set("pageSize", "20");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
        const data = await get(url);
        return {
          ...pick(data, ["nextPageToken", "incompleteSearch"]),
          files: rows(data.files).map((f) => pick(f, fields.split(","))),
        };
      }
      url.searchParams.set("fields", fields);
      const data = await get(url);
      requireThat(data.id === args.fileId, "google_invalid_response", 502);
      return pick(data, fields.split(","));
    }
    case "gmail": {
      const args = gmailQuery.parse(input);
      const url = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages${args.resource === "message" ? `/${args.messageId}` : ""}`,
      );
      if (args.resource === "messages") {
        url.searchParams.set("maxResults", "20");
        if (args.query) url.searchParams.set("q", args.query);
        if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
        const data = await get(url);
        return {
          ...pick(data, ["nextPageToken", "resultSizeEstimate"]),
          messages: rows(data.messages).map((m) => pick(m, ["id", "threadId"])),
        };
      }
      url.searchParams.set("format", "full");
      const data = await get(url);
      requireThat(data.id === args.messageId, "google_invalid_response", 502);
      const headers = rows(row(data.payload).headers)
        .filter(
          (h) =>
            typeof h.name === "string" &&
            ["from", "to", "cc", "subject", "date"].includes(
              h.name.toLowerCase(),
            ),
        )
        .map((h) => pick(h, ["name", "value"]));
      const text = plainParts(data.payload).join("\n");
      return {
        ...pick(data, [
          "id",
          "threadId",
          "labelIds",
          "snippet",
          "internalDate",
        ]),
        headers,
        text,
        plainTextAvailable: !!text,
        contentIsUntrusted: true,
      };
    }
  }
}
