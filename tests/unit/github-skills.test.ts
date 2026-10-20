import { describe, expect, test } from "bun:test";
import {
  GitHubSkillReader,
  parseGitHubSkillLink,
  publicSkillResource,
} from "../../src/skills/github-source.ts";
import { harnessSkills } from "../fixtures/harness-skills.ts";
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
    ).toBe("invalid_markdown");
  });
  test("imports the reported harness metadata and recursively bundles linked guides from the pinned tree", async () => {
    const { transport, state } = skillGitHubFixture();
    state.files.clear();
    for (const [name, body] of Object.entries(harnessSkills))
      state.files.set(`skills/${name}/SKILL.md`, body);
    state.files.set(
      "skills/new-project/WEB.md",
      "Web guide. [API][api]\n\n[api]: references/API.md#usage",
    );
    state.files.set("skills/new-project/DESIGN.md", "Design guide.");
    state.files.set(
      "skills/new-project/references/API.md",
      "[Back](../WEB.md) [Remote](https://example.com/private.md) [Outside](../../../private.md) [Script](install.sh)",
    );
    state.files.set("private.md", "Must never load.");
    const reader = new GitHubSkillReader((path) =>
      publicSkillResource(skillRepository, path, transport),
    );
    const result = await reader.discover(parseGitHubSkillLink(skillLink));
    expect(result.skills).toHaveLength(4);
    expect(
      result.skills.every((candidate) => candidate.spec && !candidate.error),
    ).toBe(true);
    expect(
      result.skills.find(
        (candidate) => candidate.spec?.slug === "live-system-chrome",
      )?.spec?.frontmatter?.metadata?.compatibility,
    ).toContain("Chrome 144");
    const project = result.skills.find(
      (candidate) => candidate.spec?.slug === "new-project",
    );
    expect(project?.spec?.resources?.map((file) => file.path)).toEqual([
      "DESIGN.md",
      "references/API.md",
      "WEB.md",
    ]);
    expect(project?.bundleHash).toHaveLength(64);
    expect(
      state.requests.filter((request) => request.url.includes("git/trees")),
    ).toHaveLength(1);
    expect(
      state.requests.every(
        (request) => new URL(request.url).hostname === "api.github.com",
      ),
    ).toBe(true);
  });
  test("missing files, other skill packages and symlinks cannot supply supporting content", async () => {
    const { transport, state } = skillGitHubFixture();
    const reader = new GitHubSkillReader((path) =>
      publicSkillResource(skillRepository, path, transport),
    );
    for (const target of [
      "missing.md",
      "linked/SKILL.md",
      "skills/second/README.md",
    ]) {
      state.files.set(
        "SKILL.md",
        skillMarkdown("with-guide", `[Guide](${target})`),
      );
      state.files.set("skills/second/README.md", "Other skill content.");
      const result = await reader.discover(
        parseGitHubSkillLink(`${skillLink}/blob/main/SKILL.md`),
      );
      expect(result.skills[0]?.error).toBe("skill_reference_unavailable");
    }
  });
  test("supporting files enforce secret, binary, individual size, total size and count boundaries", async () => {
    const { transport, state } = skillGitHubFixture();
    const reader = new GitHubSkillReader((path) =>
      publicSkillResource(skillRepository, path, transport),
    );
    for (const body of [
      `sk-${"x".repeat(25)}`,
      "binary\0text",
      "a".repeat(65537),
    ]) {
      state.files.set(
        "SKILL.md",
        skillMarkdown("with-guide", "[Guide](guide.md)"),
      );
      state.files.set("guide.md", body);
      const result = await reader.discover(
        parseGitHubSkillLink(`${skillLink}/blob/main/SKILL.md`),
      );
      expect(result.skills[0]?.error).toBe(
        body.length > 65536
          ? "invalid_skill_resources"
          : "skill_contains_secret_or_binary",
      );
    }
    for (const count of [5, 33]) {
      state.files.set(
        "SKILL.md",
        skillMarkdown(
          "with-guides",
          Array.from(
            { length: count },
            (_, index) => `[Guide](guide-${index}.md)`,
          ).join("\n"),
        ),
      );
      for (let index = 0; index < count; index++)
        state.files.set(
          `guide-${index}.md`,
          "a".repeat(count === 5 ? 65536 : 1),
        );
      const result = await reader.discover(
        parseGitHubSkillLink(`${skillLink}/blob/main/SKILL.md`),
      );
      expect(result.skills[0]?.error).toBe("invalid_skill_resources");
    }
  });
});
