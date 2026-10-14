import { describe, expect, test } from "bun:test";
import {
  GitHubSkillReader,
  parseGitHubSkillLink,
  publicSkillResource,
} from "../../src/skills/github-source.ts";
import {
  skillGitHubFixture,
  skillLink,
  skillMarkdown,
  skillRepository,
} from "../skills-github-fixture.ts";

describe("GitHub skill source discovery", () => {
  test("accepts repository, folder and file links, rejects other hosts and unsafe paths", () => {
    expect(parseGitHubSkillLink(`${skillLink}.git`).repository).toBe(
      skillRepository,
    );
    expect(parseGitHubSkillLink(`${skillLink}/tree/main/skills`).kind).toBe(
      "tree",
    );
    expect(
      parseGitHubSkillLink(`${skillLink}/blob/main/SKILL.md#preview`).kind,
    ).toBe("blob");
    for (const url of [
      "http://github.com/a/b",
      "https://github.com.evil/a/b",
      "https://user:pass@github.com/a/b",
      `${skillLink}/issues/1`,
      `${skillLink}?token=private`,
      `${skillLink}/tree/main/%2e%2e%2fsecret`,
      `${skillLink}/blob/main/README.md`,
    ])
      expect(() => parseGitHubSkillLink(url)).toThrow(
        "invalid_github_skill_url",
      );
  });
  test("discovers all nested skills, reports invalid files and ignores symlinks", async () => {
    const { transport, state } = skillGitHubFixture();
    const reader = new GitHubSkillReader((path) =>
      publicSkillResource(skillRepository, path, transport),
    );
    const result = await reader.discover(parseGitHubSkillLink(skillLink));
    expect(result.commit).toBe(state.commit);
    expect(result.skills).toHaveLength(3);
    expect(result.skills.find((s) => s.path === "SKILL.md")?.spec?.slug).toBe(
      "source-recap",
    );
    expect(result.skills.find((s) => s.path.includes("broken"))?.error).toBe(
      "frontmatter_required",
    );
    expect(
      state.requests.every(
        (r) =>
          !new Headers(r.init.headers).has("authorization") &&
          r.init.redirect === "error",
      ),
    ).toBe(true);
  });
  test("folder and direct links limit discovery and slash-containing refs resolve correctly", async () => {
    const { transport, state } = skillGitHubFixture();
    const reader = new GitHubSkillReader((path) =>
      publicSkillResource(skillRepository, path, transport),
    );
    expect(
      (
        await reader.discover(
          parseGitHubSkillLink(`${skillLink}/tree/main/skills/second`),
        )
      ).skills.map((s) => s.path),
    ).toEqual(["skills/second/SKILL.md"]);
    expect(
      (
        await reader.discover(
          parseGitHubSkillLink(`${skillLink}/blob/main/SKILL.md`),
        )
      ).skills,
    ).toHaveLength(1);
    state.ref = "feature/skills";
    const result = await reader.discover(
      parseGitHubSkillLink(`${skillLink}/tree/feature/skills/skills/second`),
    );
    expect(result.ref).toBe("feature/skills");
    expect(result.scope).toBe("skills/second");
    expect(result.skills).toHaveLength(1);
  });
  test("never imports a partial tree and keeps oversized, secret and invalid UTF-8 candidates unavailable", async () => {
    const { transport, state } = skillGitHubFixture();
    const reader = new GitHubSkillReader((path) =>
      publicSkillResource(skillRepository, path, transport),
    );
    state.truncated = true;
    await expect(
      reader.discover(parseGitHubSkillLink(skillLink)),
    ).rejects.toThrow("github_skill_repository_too_large");
    state.truncated = false;
    state.files.set("oversize/SKILL.md", "x".repeat(20000));
    state.files.set(
      "secret/SKILL.md",
      skillMarkdown("secret-skill", `sk-${"x".repeat(25)}`),
    );
    const found = await reader.discover(parseGitHubSkillLink(skillLink));
    expect(found.skills.find((s) => s.path.startsWith("oversize"))?.error).toBe(
      "invalid_markdown",
    );
    expect(found.skills.find((s) => s.path.startsWith("secret"))?.error).toBe(
      "skill_contains_secret_or_binary",
    );
    const invalid = new GitHubSkillReader(async () => ({
      sha: "a".repeat(40),
      encoding: "base64",
      size: 1,
      content: "/w==",
    }));
    expect(
      (await invalid.candidate({ path: "SKILL.md", sha: "a".repeat(40) }))
        .error,
    ).toBe("invalid_skill_metadata");
  });
});
