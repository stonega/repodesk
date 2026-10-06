import type { Run } from "../src/domain.ts";
import { DataDetails, detailLabel } from "./data-details.tsx";

export function RunAttempts({ attempts }: { attempts: Run["attempts"] }) {
  return (
    <section className="run-attempts" aria-label="Attempts">
      <h3>
        Attempts <span className="pill">{attempts.length}</span>
      </h3>
      {!attempts.length ? (
        <p className="muted">No model attempts yet.</p>
      ) : (
        <section
          className="run-attempts-scroll"
          aria-label="Attempt timeline"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Allows keyboard scrolling of the horizontal timeline.
          tabIndex={0}
        >
          <ol className="run-attempts-timeline">
            {attempts.map((attempt, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Attempts are an ordered snapshot; metadata-only API records may omit IDs.
              <li className="run-attempt" key={index}>
                <div className="run-attempt-step">
                  <span className="run-attempt-marker" aria-hidden="true">
                    {index + 1}
                  </span>
                  <strong>Attempt {index + 1}</strong>
                </div>
                <div className="run-attempt-card">
                  <span
                    className="pill run-attempt-status"
                    data-status={attempt.status}
                  >
                    {attempt.status === "reserved"
                      ? "Reserved"
                      : detailLabel(attempt.status)}
                  </span>
                  <DataDetails
                    value={{
                      at: attempt.at,
                      reserved: attempt.reserved,
                      actual: attempt.actual,
                    }}
                  />
                  {(attempt.id ||
                    attempt.purpose ||
                    attempt.tokens ||
                    attempt.reconciliation) && (
                    <details>
                      <summary>More details</summary>
                      <DataDetails
                        value={{
                          id: attempt.id,
                          purpose: attempt.purpose,
                          tokens: attempt.tokens,
                          reconciliation: attempt.reconciliation,
                        }}
                      />
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
