import { useContext, useEffect, useRef, useState } from "react";
import type { Skill, SkillSpec } from "../src/domain.ts";
import type { GitHubSkillDiscovery } from "../src/skills/github-source.ts";
import { ModalActions, ModalPending } from "./modal.tsx";
import { Select } from "./select.tsx";
import { useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const messages: Record<string, string> = {
  invalid_github_skill_url:
    "Enter an HTTPS github.com repository, folder, or SKILL.md link.",
  github_unavailable: "GitHub is unavailable. Try checking the source again.",
  github_rate_limited:
    "GitHub has temporarily limited requests. Try again later.",
  github_access_denied:
    "GitHub could not read this source. For private repositories, connect it to this workspace and grant the GitHub App Contents access.",
  github_repository_not_connected:
    "This source repository is no longer connected to the workspace. Reconnect it before updating.",
  github_app_not_configured:
    "Configure the workspace's GitHub App before importing a connected repository.",
  github_app_permissions_missing:
    "Grant the GitHub App Contents-read access to this repository.",
  github_skill_ref_not_found:
    "The branch or tag could not be found. Check the link and repository access.",
  github_skill_source_changed:
    "The repository changed since this preview. Check the source again before saving.",
  github_skill_already_imported:
    "This skill is already imported. Use Check for updates on its card.",
  github_skill_source_missing:
    "The source SKILL.md was removed or moved. Your saved skill is preserved.",
  github_skill_repository_too_large:
    "GitHub returned an incomplete or oversized tree. Use a smaller repository to ensure complete discovery.",
  github_too_many_skills:
    "This link contains more than 100 skills. Link to a smaller folder.",
  github_skill_local_changes:
    "The draft has local edits. Review them and confirm replacement before updating.",
  duplicate_slug:
    "A skill with this name already exists. Rename the existing draft before importing.",
  invalid_markdown: "The file must be valid UTF-8 Markdown, at most 16 KB.",
  unsupported_frontmatter:
    "This skill uses unsupported frontmatter. Supported fields: name, description, allowed-tools.",
  invalid_skill_metadata:
    "The skill metadata or requested tools are unsupported.",
  frontmatter_required:
    "This file needs SKILL.md name and description frontmatter.",
  skill_contains_secret_or_binary:
    "This skill contains a secret or binary content and cannot be imported.",
};
function message(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return messages[code] ?? code;
}
function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const pending = useContext(ModalPending);
  useEffect(() => () => pending?.(false), [pending]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    pending?.(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      running.current = false;
      setBusy(false);
      pending?.(false);
    }
  };
  return { busy, error, run };
}

export function SkillImport({
  id,
  request,
  saved,
}: {
  id: string;
  request: Request;
  saved: () => void;
}) {
  const [mode, setMode] = useState("github");
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [discovery, setDiscovery] = useState<GitHubSkillDiscovery>();
  const [selected, setSelected] = useState<string[]>([]);
  const { busy, error, run } = useOperation();
  const notify = useToast();
  const base = `/api/admin/workspaces/${id}/skills`;
  return (
    <>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: Select binds its dropdown trigger to the enclosing label. */}
      <label className="field">
        <span>Import from</span>
        <Select
          value={mode}
          disabled={busy}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="github">GitHub link</option>
          <option value="markdown">Markdown file</option>
        </Select>
      </label>
      {mode === "github" ? (
        <>
          <p className="muted">
            Paste a repository, folder, or SKILL.md link. Private repositories
            use this workspace's connected GitHub App. Only instruction Markdown
            is imported.
          </p>
          <label className="field">
            <span>GitHub link</span>
            <input
              type="url"
              placeholder="https://github.com/owner/repository"
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setDiscovery(undefined);
                setSelected([]);
              }}
            />
          </label>
          {discovery && (
            <section
              className="skill-source-discovery"
              aria-label="Discovered skills"
            >
              <p className="muted">
                {discovery.skills.length}{" "}
                {discovery.skills.length === 1 ? "skill" : "skills"} found ·{" "}
                {discovery.access === "connected"
                  ? "Connected GitHub App"
                  : "Public repository"}{" "}
                · {discovery.ref} at {discovery.commit.slice(0, 7)}
              </p>
              {!discovery.skills.length && (
                <p role="status">
                  No SKILL.md files found in this link. Try the repository root
                  or another folder.
                </p>
              )}
              {discovery.skills.map((skill) => {
                const unavailable =
                  !!skill.error || skill.alreadyImported || skill.duplicate;
                return (
                  <div className="skill-source-option" key={skill.path}>
                    <label className="check">
                      <input
                        type="checkbox"
                        disabled={busy || unavailable}
                        checked={selected.includes(skill.path)}
                        onChange={(e) =>
                          setSelected((paths) =>
                            e.target.checked
                              ? [...paths, skill.path]
                              : paths.filter((path) => path !== skill.path),
                          )
                        }
                      />
                      <span>{skill.spec?.name ?? skill.path}</span>
                    </label>
                    <p className="muted skill-source-path">{skill.path}</p>
                    {skill.spec && <p>{skill.spec.description}</p>}
                    {unavailable && (
                      <p className="muted">
                        {skill.error
                          ? message(skill.error)
                          : skill.alreadyImported
                            ? "Already imported. Check for updates on its card."
                            : "Duplicate skill name. Rename the existing draft or choose a source with a unique name."}
                      </p>
                    )}
                    {skill.spec && (
                      <details>
                        <summary>Preview instructions</summary>
                        <p className="prose">{skill.spec.body}</p>
                      </details>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Frontmatter supports name, description, and allowed-tools. Files are
            limited to 16 KB; executable bundles are not imported.
          </p>
          <label className="field">
            <span>Markdown file</span>
            <input
              type="file"
              accept=".md,text/markdown"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void run(async () => {
                    if (file.size > 16384) throw Error("invalid_markdown");
                    setMarkdown(await file.text());
                  });
              }}
            />
          </label>
          <label className="field">
            <span>Markdown contents</span>
            <textarea
              rows={8}
              value={markdown}
              disabled={busy}
              onChange={(e) => setMarkdown(e.target.value)}
            />
          </label>
        </>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="skill-source-retry">
        {mode === "github" && discovery && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setDiscovery(undefined);
              setSelected([]);
            }}
          >
            Check source again
          </button>
        )}
      </div>
      <ModalActions>
        {mode === "github" && !discovery ? (
          <button
            type="button"
            disabled={busy || !url.trim()}
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                const result = await request<GitHubSkillDiscovery>(
                  `${base}/github/discover`,
                  "POST",
                  { url },
                );
                setDiscovery(result);
                setSelected(
                  result.skills.length === 1 &&
                    result.skills[0]?.spec &&
                    !result.skills[0].error &&
                    !result.skills[0].alreadyImported &&
                    !result.skills[0].duplicate
                    ? [result.skills[0].path]
                    : [],
                );
              })
            }
          >
            {busy ? "Checking…" : "Find skills"}
          </button>
        ) : (
          <button
            type="button"
            disabled={
              busy || (mode === "github" ? !selected.length : !markdown.trim())
            }
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                if (mode === "github" && discovery)
                  await request(`${base}/github/import`, "POST", {
                    url,
                    commit: discovery.commit,
                    paths: selected,
                  });
                else await request(`${base}/import`, "POST", { markdown });
                notify(
                  mode === "github"
                    ? `${selected.length} skill drafts imported. Review and publish them before enabling.`
                    : "Skill draft imported.",
                );
                saved();
              })
            }
          >
            {busy
              ? "Importing…"
              : mode === "github"
                ? `Import ${selected.length || "selected"} ${selected.length === 1 ? "draft" : "drafts"}`
                : "Import draft"}
          </button>
        )}
      </ModalActions>
    </>
  );
}

type Update = {
  commit: string;
  changed: boolean;
  locallyModified: boolean;
  spec: SkillSpec;
};
export function SkillGitHubUpdate({
  id,
  skill,
  request,
  saved,
}: {
  id: string;
  skill: Skill;
  request: Request;
  saved: () => void;
}) {
  const [result, setResult] = useState<Update>();
  const [replaceLocal, setReplaceLocal] = useState(false);
  const { busy, error, run } = useOperation();
  const notify = useToast();
  const base = `/api/admin/workspaces/${id}/skills/${skill.id}/github`;
  return (
    <>
      <p className="muted">
        Check the tracked {skill.githubSource?.ref} source for changes. Updates
        replace the draft for review. Published versions and scheduled skills
        keep their current instructions.
      </p>
      {result &&
        (!result.changed ? (
          <p role="status">This skill is up to date with its source.</p>
        ) : (
          <>
            <p role="status">
              An update is available at {result.commit.slice(0, 7)}.
            </p>
            <div className="skill-update-comparison">
              <section>
                <h3>Current draft</h3>
                <p>{skill.draft.description}</p>
                <pre>{skill.draft.body}</pre>
              </section>
              <section>
                <h3>Source update</h3>
                <p>{result.spec.description}</p>
                <pre>{result.spec.body}</pre>
              </section>
            </div>
            <details>
              <summary>Settings and requested tools</summary>
              <pre>
                {JSON.stringify(
                  {
                    current: {
                      slug: skill.draft.slug,
                      tools: skill.draft.tools,
                      settings: skill.draft.settings,
                    },
                    update: {
                      slug: result.spec.slug,
                      tools: result.spec.tools,
                      settings: result.spec.settings,
                    },
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {result.locallyModified && (
              <>
                <p className="notice">
                  Your draft has local edits. Saving this update replaces them.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={replaceLocal}
                    disabled={busy}
                    onChange={(e) => setReplaceLocal(e.target.checked)}
                  />
                  Replace my local draft edits
                </label>
              </>
            )}
          </>
        ))}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="skill-source-retry">
        {result?.changed && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setResult(undefined);
              setReplaceLocal(false);
            }}
          >
            Check source again
          </button>
        )}
      </div>
      <ModalActions>
        {result?.changed ? (
          <button
            type="button"
            disabled={busy || (result.locallyModified && !replaceLocal)}
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                await request(`${base}/update`, "POST", {
                  version: skill.version,
                  commit: result.commit,
                  replaceLocal,
                });
                notify(
                  "Source update saved as a draft. Review and publish it to use the new instructions.",
                );
                saved();
              })
            }
          >
            {busy ? "Saving…" : "Save update draft"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                setResult(
                  await request<Update>(`${base}/check`, "POST", {
                    version: skill.version,
                  }),
                );
                setReplaceLocal(false);
              })
            }
          >
            {busy ? "Checking…" : "Check for updates"}
          </button>
        )}
      </ModalActions>
    </>
  );
}
