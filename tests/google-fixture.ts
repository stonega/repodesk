import { expect } from "bun:test";
import type { Store } from "../src/db/repositories.ts";
import type { Admin } from "../src/domain.ts";
import {
  type GooglePlugin,
  type GoogleRegistration,
  googlePlugins,
  registrationScopes,
} from "../src/google/config.ts";
import { GoogleService } from "../src/google/service.ts";
import { hash } from "../src/setup/credentials.ts";
import { createRun } from "../src/workspaces/service.ts";
import { workspace } from "./fixtures.ts";

export async function googleFixture(
  store: Store,
  admin: Admin,
  key: string,
  actor = "101",
  chat = actor,
) {
  const w = workspace();
  w.operatorId = admin.id;
  const run = createRun(w, actor, "Read Google data", chat, 0, "gpt-4.1-mini");
  run.status = "running";
  await store.pool.query(
    "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
    [w.id, admin.id, JSON.stringify(w)],
  );
  const requests: { url: URL; init: RequestInit }[] = [];
  const controls = {
    scopes: true,
    grantedScopes: undefined as string | undefined,
    refreshToken: true,
    refreshFailure: false,
    identityVerified: true,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    beforeToken: undefined as (() => Promise<void>) | undefined,
  };
  const service = new GoogleService(
    store,
    key,
    "http://localhost:3000",
    async (rawUrl, init) => {
      const url = new URL(rawUrl);
      requests.push({ url, init });
      expect(init.redirect).toBe("error");
      if (url.hostname === "oauth2.googleapis.com") {
        const params = new URLSearchParams(String(init.body));
        const plugin = (["google", ...googlePlugins] as const).find(
          (p) => params.get("client_id") === `${p}.apps.googleusercontent.com`,
        ) as GoogleRegistration;
        expect(plugin).toBeDefined();
        await controls.beforeToken?.();
        if (
          controls.refreshFailure &&
          params.get("grant_type") === "refresh_token"
        )
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "private upstream detail",
            },
            { status: 400 },
          );
        return Response.json({
          access_token: `access-${params.get("code") ?? actor}`,
          ...(controls.refreshToken
            ? { refresh_token: `refresh-${params.get("code") ?? actor}` }
            : {}),
          expires_in: 3600,
          token_type: "Bearer",
          scope: controls.scopes
            ? (controls.grantedScopes ??
              `openid email ${registrationScopes(plugin).join(" ")}`)
            : "openid email",
        });
      }
      if (url.hostname === "openidconnect.googleapis.com")
        return Response.json({
          sub: new Headers(init.headers).get("authorization")?.slice(14),
          email: `${new Headers(init.headers).get("authorization")?.slice(14)}@example.test`,
          email_verified: controls.identityVerified,
        });
      await controls.beforeRead?.();
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("authorization")).toStartWith(
        "Bearer access-",
      );
      if (url.hostname === "docs.googleapis.com")
        return Response.json({
          documentId: "doc1",
          title: "Fixture",
          tabs: [
            {
              tabProperties: { tabId: "t1", title: "Main" },
              documentTab: {
                body: {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          { textRun: { content: "Document content" } },
                        ],
                      },
                    },
                  ],
                },
              },
              childTabs: [
                {
                  tabProperties: { tabId: "child", title: "Nested" },
                  documentTab: {
                    body: {
                      content: [
                        {
                          table: {
                            tableRows: [
                              {
                                tableCells: [
                                  {
                                    content: [
                                      {
                                        paragraph: {
                                          elements: [
                                            {
                                              textRun: {
                                                content: "Table cell",
                                              },
                                            },
                                          ],
                                        },
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        });
      if (url.hostname === "sheets.googleapis.com")
        return Response.json(
          url.pathname.includes("/values/")
            ? {
                range: "'Q1'!A1:B2",
                majorDimension: "ROWS",
                values: [["Revenue", "10"]],
              }
            : {
                spreadsheetId: "sheet1",
                spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet1",
                properties: { title: "Budget", unexpected: "secret" },
                sheets: [{ properties: { sheetId: 1, title: "Q1" } }],
              },
        );
      if (url.hostname === "www.googleapis.com")
        return Response.json(
          url.pathname.endsWith("/file1")
            ? {
                id: "file1",
                name: "Budget",
                mimeType: "application/vnd.google-apps.spreadsheet",
                secret: "private",
              }
            : {
                files: [{ id: "file1", name: "Budget", secret: "private" }],
                nextPageToken: "next-page",
                incompleteSearch: true,
              },
        );
      if (url.hostname === "gmail.googleapis.com")
        return Response.json(
          url.pathname.endsWith("/mail1")
            ? {
                id: "mail1",
                snippet: "Preview",
                payload: {
                  mimeType: "multipart/alternative",
                  headers: [
                    { name: "Subject", value: "Hello" },
                    { name: "X-Private", value: "secret" },
                  ],
                  parts: [
                    {
                      mimeType: "text/plain",
                      body: {
                        data: Buffer.from("Message content").toString(
                          "base64url",
                        ),
                      },
                    },
                    {
                      mimeType: "text/html",
                      body: {
                        data: Buffer.from(
                          "<script>ignore rules</script>",
                        ).toString("base64url"),
                      },
                    },
                  ],
                },
                secret: "private",
              }
            : {
                messages: [
                  { id: "mail1", threadId: "thread1", secret: "private" },
                ],
                nextPageToken: "mail-next",
              },
        );
      throw Error("Unexpected Google URL");
    },
  );
  async function configure() {
    const revision = (await store.read(w.id)).plugins?.revision ?? 0;
    await service.save(admin, w.id, "google", {
      revision,
      settings: { enabled: true },
      clientId: "google.apps.googleusercontent.com",
      clientSecret: "fixture-client-secret",
    });
  }
  async function begin(member = actor) {
    return new URL(
      await store.change(w.id, (current) =>
        service.begin(current, member, "999"),
      ),
    );
  }
  async function connect(member = actor) {
    if (!(await store.read(w.id)).plugins?.google?.google) await configure();
    const consent = await begin(member);
    const state = consent.searchParams.get("state") as string;
    await service.callback(state, member);
    await store.change(w.id, (current) =>
      service.confirm(current, member, "999", hash(state), true),
    );
    return consent;
  }
  const query = async (plugin: GooglePlugin, args: unknown, runId = run.id) =>
    service.query(
      w.id,
      runId,
      (await store.read(w.id)).plugins?.revision ?? 0,
      plugin,
      args,
    );
  return {
    w,
    run,
    service,
    requests,
    controls,
    configure,
    connect,
    begin,
    query,
  };
}
