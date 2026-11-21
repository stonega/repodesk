import type { SkillSpec } from "../src/domain.ts";
import { DataDetails, detailLabel } from "./data-details.tsx";

export function SkillSourceDetails({ spec }: { spec: SkillSpec }) {
  return (
    <>
      {spec.frontmatter && (
        <details>
          <summary>Source metadata</summary>
          <DataDetails value={spec.frontmatter} />
        </details>
      )}
      {!!spec.resources?.length && (
        <details>
          <summary>Supporting files ({spec.resources.length})</summary>
          {spec.resources.map((resource) => (
            <details key={resource.path}>
              <summary>
                <code>{resource.path}</code>
              </summary>
              <p className="prose">{resource.body}</p>
            </details>
          ))}
        </details>
      )}
    </>
  );
}

const AUDIENCE_LABELS: Record<string, string> = {
  chat: "Chat & workflows",
  coding: "Coding & reviews",
  all: "All (chat & coding)",
};

export function SkillPreview({
  spec,
  dependents,
  repositoryName,
}: {
  spec: SkillSpec;
  dependents: unknown[];
  repositoryName?: string;
}) {
  const showClassification =
    spec.scope?.kind === "project" || spec.audience !== undefined;
  const scopeText =
    spec.scope?.kind === "project"
      ? `Project · ${repositoryName ?? spec.scope.repository ?? `#${spec.scope.repositoryId}`}`
      : "Global";
  return (
    <details className="skill-card-preview">
      <summary className="skill-preview-toggle">
        Preview instructions & dependent schedules
      </summary>
      <div className="skill-preview-content">
        <p className="prose">{spec.body}</p>
        <SkillSourceDetails spec={spec} />
        <dl
          className="plugin-summary skill-preview-settings"
          aria-label="Settings"
        >
          {showClassification && (
            <>
              <div>
                <dt>Scope</dt>
                <dd>{scopeText}</dd>
              </div>
              <div>
                <dt>Applies to</dt>
                <dd>
                  {AUDIENCE_LABELS[spec.audience ?? "chat"] ?? spec.audience}
                </dd>
              </div>
            </>
          )}
          {(["maxWords", "sections"] as const).map((key) => (
            <div key={key}>
              <dt>{detailLabel(key)}</dt>
              <dd>
                <DataDetails value={spec.settings[key]} name={key} />
              </dd>
            </div>
          ))}
        </dl>
        <div className="skill-preview-tools">
          <h3>Tools</h3>
          {spec.tools.length ? (
            <ul aria-label="Required tools">
              {spec.tools.map((tool, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Read-only ordered tool declarations may repeat a name.
                <li className="skill-preview-tool" key={index}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No tools required</p>
          )}
        </div>
        {dependents.length ? (
          <div className="skill-preview-dependents">
            <h3>Dependent workflows</h3>
            <DataDetails value={dependents} />
          </div>
        ) : (
          <p className="muted skill-preview-empty">No dependent workflows</p>
        )}
      </div>
    </details>
  );
}
