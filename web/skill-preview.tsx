import type { SkillSpec } from "../src/domain.ts";
import { DataDetails, detailLabel } from "./data-details.tsx";

export function SkillPreview({
  spec,
  dependents,
}: {
  spec: SkillSpec;
  dependents: unknown[];
}) {
  return (
    <details className="skill-card-preview">
      <summary className="skill-preview-toggle">
        Preview instructions & dependent schedules
      </summary>
      <div className="skill-preview-content">
        <p className="prose">{spec.body}</p>
        <dl
          className="plugin-summary skill-preview-settings"
          aria-label="Settings"
        >
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
