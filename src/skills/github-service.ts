import { z } from "zod";
import type { Store } from "../db/repositories.ts";
import {
  requireThat,
  type Skill,
  skillSchema,
  type Workspace,
} from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { fingerprint, hash } from "../setup/credentials.ts";
import { audit, authorize } from "../workspaces/policy.ts";
import { saveManagedSkill } from "./catalog.ts";
import {
  type GitHubSkillDiscovery,
  GitHubSkillReader,
  githubSkillUrl,
  parseGitHubSkillLink,
  publicSkillResource,
} from "./github-source.ts";

export const githubImportInput = z
  .object({
    url: githubSkillUrl,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    paths: z.array(z.string().min(1).max(1000)).min(1).max(100),
  })
  .strict();
type Access = {
  access: "public" | "connected";
  repositoryId?: number;
  installationId?: number;
  revision?: number;
};

function permitted(w: Workspace, actor: string) {
  authorize(w, actor, true);
  requireThat(!w.deletion, "access_denied", 403);
}
function guardConnection(w: Workspace, access: Access, repository: string) {
  if (access.access === "public") return;
  requireThat(
    !!w.github &&
      w.github.installationId === access.installationId &&
      (access.revision === undefined ||
        w.github.revision === access.revision) &&
      w.github.repositories.some(
        (r) =>
          r.id === access.repositoryId &&
          r.full_name.toLowerCase() === repository.toLowerCase(),
      ),
    "github_repository_not_connected",
    409,
  );
}
function sameSource(
  skill: Skill,
  repository: string,
  ref: string,
  path: string,
) {
  return (
    skill.githubSource?.repository.toLowerCase() === repository.toLowerCase() &&
    skill.githubSource.ref === ref &&
    skill.githubSource.path === path
  );
}

function unchangedDraft(skill: Skill) {
  const saved = skill.githubSource?.draftHash;
  return (
    saved === fingerprint(skill.draft) ||
    // Older imports hashed schema-ordered JSON before PostgreSQL reordered keys.
    saved === hash(JSON.stringify(skillSchema.parse(skill.draft)))
  );
}

/** Imported instructions never execute files or broaden GitHub/tool permissions. */
export class GitHubSkills {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private transport: typeof fetch = fetch,
  ) {}
  private async reader(
    w: Workspace,
    repository: string,
    source?: NonNullable<Skill["githubSource"]>,
  ) {
    const selected = w.github?.repositories.find(
      (r) => r.full_name.toLowerCase() === repository.toLowerCase(),
    );
    if (source?.access === "connected") guardConnection(w, source, repository);
    if (selected && w.github?.installationId && source?.access !== "public") {
      const access: Access = {
        access: "connected",
        repositoryId: selected.id,
        installationId: w.github.installationId,
        revision: w.github.revision,
      };
      const app = await this.apps.get(w.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      const token = await app.installationToken(
        w.github.installationId,
        [selected.id],
        "contents",
      );
      return {
        access,
        reader: new GitHubSkillReader((path) =>
          app.skillResource(token.token, repository, path),
        ),
      };
    }
    return {
      access: { access: "public" } as Access,
      reader: new GitHubSkillReader((path) =>
        publicSkillResource(repository, path, this.transport),
      ),
    };
  }
  private async scan(w: Workspace, actor: string, url: string) {
    permitted(w, actor);
    const link = parseGitHubSkillLink(url);
    const { reader, access } = await this.reader(w, link.repository);
    const found = await reader.discover(link);
    for (const candidate of found.skills) {
      candidate.alreadyImported = w.skills.some((s) =>
        sameSource(s, link.repository, found.ref, candidate.path),
      );
      candidate.duplicate =
        !!candidate.spec &&
        w.skills.some((s) => s.draft.slug === candidate.spec?.slug);
    }
    const discovery: GitHubSkillDiscovery = {
      repository: link.repository,
      ...found,
      access: access.access,
    };
    return { discovery, access };
  }
  async discover(id: string, actor: string, url: string) {
    const { discovery, access } = await this.scan(
      await this.store.read(id),
      actor,
      url,
    );
    const current = await this.store.read(id);
    permitted(current, actor);
    guardConnection(current, access, discovery.repository);
    return discovery;
  }
  async import(id: string, actor: string, value: unknown) {
    const input = githubImportInput.parse(value);
    requireThat(
      new Set(input.paths).size === input.paths.length,
      "duplicate_skill_selection",
    );
    const { discovery, access } = await this.scan(
      await this.store.read(id),
      actor,
      input.url,
    );
    requireThat(
      discovery.commit === input.commit,
      "github_skill_source_changed",
      409,
    );
    const candidates = input.paths.map((path) => {
      const candidate = discovery.skills.find((s) => s.path === path);
      requireThat(
        candidate?.spec && !candidate.error,
        "invalid_github_skill_selection",
      );
      return candidate;
    });
    return this.store.change(id, (w) => {
      permitted(w, actor);
      guardConnection(w, access, discovery.repository);
      requireThat(
        !candidates.some((c) =>
          w.skills.some((s) =>
            sameSource(s, discovery.repository, discovery.ref, c.path),
          ),
        ),
        "github_skill_already_imported",
        409,
      );
      return {
        items: candidates.map((candidate) => {
          requireThat(candidate.spec, "invalid_skill_metadata");
          const skill: Skill = saveManagedSkill(w, actor, candidate.spec);
          skill.githubSource = {
            repository: discovery.repository,
            ref: discovery.ref,
            path: candidate.path,
            commit: discovery.commit,
            blobSha: candidate.sha,
            ...(candidate.bundleHash
              ? { bundleHash: candidate.bundleHash }
              : {}),
            draftHash: fingerprint(skill.draft),
            importedAt: new Date().toISOString(),
            access: access.access,
            ...(access.repositoryId
              ? {
                  repositoryId: access.repositoryId,
                  installationId: access.installationId,
                }
              : {}),
          };
          audit(w, actor, "skill.github_imported", skill.id, skill.version);
          return skill;
        }),
      };
    });
  }
  private async updateCandidate(
    id: string,
    actor: string,
    skillId: string,
    version: number,
  ) {
    const w = await this.store.read(id);
    permitted(w, actor);
    const skill = w.skills.find((s) => s.id === skillId);
    requireThat(skill?.githubSource, "github_skill_source_not_found", 404);
    requireThat(skill.version === version, "version_conflict", 409);
    requireThat(!skill.archived, "github_skill_archived", 409);
    const source = skill.githubSource;
    const { reader, access } = await this.reader(w, source.repository, source);
    const commit = await reader.commit(source.ref);
    const tree = await reader.tree(commit);
    const file = (await reader.files(commit, source.path, true, tree))[0];
    requireThat(file, "github_skill_source_missing", 404);
    const candidate = await reader.candidate(file, tree);
    requireThat(
      candidate.spec && !candidate.error,
      candidate.error ?? "invalid_skill_metadata",
    );
    return {
      candidate,
      commit,
      access,
      source,
      changed:
        file.sha !== source.blobSha ||
        candidate.bundleHash !== source.bundleHash,
      locallyModified: !unchangedDraft(skill),
    };
  }
  async check(id: string, actor: string, skillId: string, version: number) {
    const result = await this.updateCandidate(id, actor, skillId, version);
    const current = await this.store.read(id);
    permitted(current, actor);
    guardConnection(current, result.access, result.source.repository);
    requireThat(
      current.skills.find((s) => s.id === skillId)?.version === version,
      "version_conflict",
      409,
    );
    return {
      commit: result.commit,
      changed: result.changed,
      locallyModified: result.locallyModified,
      spec: result.candidate.spec,
    };
  }
  async update(
    id: string,
    actor: string,
    skillId: string,
    version: number,
    commit: string,
    replaceLocal: boolean,
  ) {
    const result = await this.updateCandidate(id, actor, skillId, version);
    requireThat(result.commit === commit, "github_skill_source_changed", 409);
    return this.store.change(id, (w) => {
      permitted(w, actor);
      guardConnection(w, result.access, result.source.repository);
      const skill = w.skills.find((s) => s.id === skillId);
      requireThat(
        skill?.githubSource && skill.version === version,
        "version_conflict",
        409,
      );
      requireThat(!skill.archived, "github_skill_archived", 409);
      requireThat(
        unchangedDraft(skill) || replaceLocal,
        "github_skill_local_changes",
        409,
      );
      if (!result.changed) return skill;
      requireThat(result.candidate.spec, "invalid_skill_metadata");
      saveManagedSkill(w, actor, result.candidate.spec, skill.id, version);
      skill.githubSource = {
        ...skill.githubSource,
        commit,
        blobSha: result.candidate.sha,
        bundleHash: result.candidate.bundleHash,
        draftHash: fingerprint(skill.draft),
        importedAt: new Date().toISOString(),
      };
      audit(w, actor, "skill.github_updated", skill.id, skill.version);
      return skill;
    });
  }
}
