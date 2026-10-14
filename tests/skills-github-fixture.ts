import { createHash } from "node:crypto";
import { GitHubApp } from "../src/github/app.ts";
import { githubFixtureConfig } from "./github-fixture.ts";

export const skillRepository = "example/workspace";
export const skillLink = `https://github.com/${skillRepository}`;
export const skillMarkdown = (
  name = "source-recap",
  body = "Summarize supplied sources.",
) =>
  `---\nname: ${name}\ndescription: A reusable source procedure\n---\n${body}`;
export function skillGitHubFixture() {
  const state = {
    commit: "a".repeat(40),
    ref: "main",
    truncated: false,
    private: false,
    status: 200,
    wait: Promise.resolve(),
    files: new Map([
      ["SKILL.md", skillMarkdown()],
      ["skills/second/SKILL.md", skillMarkdown("second-skill")],
      ["skills/broken/SKILL.md", "not frontmatter"],
    ]),
    requests: [] as { url: string; init: RequestInit }[],
  };
  const blobSha = (body: string) =>
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(body)}\0${body}`)
      .digest("hex");
  const transport = (async (input, init = {}) => {
    const url = new URL(String(input));
    state.requests.push({ url: url.href, init });
    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "ghs_skill_fixture",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    await state.wait;
    if (state.status !== 200)
      return Response.json(
        { message: "unavailable" },
        { status: state.status },
      );
    if (
      state.private &&
      new Headers(init.headers).get("authorization") !==
        "Bearer ghs_skill_fixture"
    )
      return Response.json({ message: "private" }, { status: 404 });
    const base = `/repos/${skillRepository}`;
    if (url.pathname === base)
      return Response.json({ id: 7001, default_branch: state.ref });
    if (decodeURIComponent(url.pathname) === `${base}/commits/${state.ref}`)
      return Response.json({ sha: state.commit });
    if (url.pathname === `${base}/git/trees/${state.commit}`)
      return Response.json({
        truncated: state.truncated,
        tree: [
          ...Array.from(state.files, ([path, body]) => ({
            path,
            type: "blob",
            mode: "100644",
            sha: blobSha(body),
            size: Buffer.byteLength(body),
          })),
          {
            path: "linked/SKILL.md",
            type: "blob",
            mode: "120000",
            sha: "e".repeat(40),
            size: 6,
          },
        ],
      });
    for (const body of state.files.values())
      if (url.pathname === `${base}/git/blobs/${blobSha(body)}`)
        return Response.json({
          sha: blobSha(body),
          encoding: "base64",
          size: Buffer.byteLength(body),
          content: Buffer.from(body).toString("base64"),
        });
    return Response.json({ message: "not found" }, { status: 404 });
  }) as typeof fetch;
  return {
    state,
    transport,
    app: new GitHubApp(githubFixtureConfig, transport),
  };
}
