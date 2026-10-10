import { useContext, useEffect, useId, useState } from "react";
import { ModalActions, ModalPending } from "./modal.tsx";
import { Select } from "./select.tsx";

export interface FormField {
  path: string;
  label: string;
  kind?:
    | "text"
    | "number"
    | "textarea"
    | "password"
    | "checkbox"
    | "select"
    | "choices";
  required?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
  maxLength?: number;
  minLength?: number;
  help?: string;
  options?: { value: string; label: string }[];
  numeric?: boolean;
  when?: { path: string; value: unknown };
}
function get(record: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      record,
    );
}
function set(record: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) return;
  let target = record;
  for (const part of parts) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  if (value === undefined) delete target[key];
  else target[key] = value;
}
export function prefixFields(prefix: string, fields: FormField[]): FormField[] {
  return fields.map((field) => ({
    ...field,
    path: prefix + field.path,
    when: field.when
      ? { ...field.when, path: prefix + field.when.path }
      : undefined,
  }));
}

/** Explicit fields edit only allowed values; versions and bound IDs stay in the payload. */
export function RecordForm({
  value,
  fields,
  save,
  label = "Save changes",
  pendingLabel = "Saving…",
}: {
  value: unknown;
  fields: FormField[];
  save: (value: unknown) => Promise<unknown>;
  label?: string;
  pendingLabel?: string;
}) {
  const initial = JSON.stringify(value);
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    JSON.parse(initial),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const modalPending = useContext(ModalPending);
  const formId = useId();
  useEffect(() => {
    setDraft(JSON.parse(initial));
    setError("");
    setIssues([]);
  }, [initial]);
  const change = (path: string, next: unknown) => {
    setDraft((current) => {
      const copy = structuredClone(current);
      set(copy, path, next);
      return copy;
    });
    setIssues((current) => current.filter((issue) => issue.path !== path));
    setError("");
  };
  return (
    <form
      className="record-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        modalPending?.(true);
        setError("");
        setIssues([]);
        try {
          const payload = structuredClone(draft);
          for (const field of fields) {
            if (field.when && get(draft, field.when.path) !== field.when.value)
              set(payload, field.path, undefined);
            else if (!field.required && get(payload, field.path) === "")
              set(payload, field.path, undefined);
          }
          await save(payload);
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : "Could not save. Please try again.",
          );
          if (
            error &&
            typeof error === "object" &&
            "issues" in error &&
            Array.isArray(error.issues)
          )
            setIssues(error.issues);
        } finally {
          setBusy(false);
          modalPending?.(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        {fields
          .filter(
            (field) =>
              !field.when || get(draft, field.when.path) === field.when.value,
          )
          .map((field) => {
            const id = `${formId}-${field.path}`;
            const current = get(draft, field.path);
            const issue = issues.find(
              (issue) => issue.path === field.path,
            )?.message;
            const common = {
              id,
              required: field.required,
              "aria-invalid": !!issue,
              "aria-describedby": issue
                ? `${id}-error`
                : field.help
                  ? `${id}-help`
                  : undefined,
            };
            return (
              <div className="field" key={field.path}>
                {field.kind === "choices" ? (
                  <fieldset className="choice-fields">
                    <legend>{field.label}</legend>
                    {field.options?.map((option) => (
                      <label key={option.value} className="form-check">
                        <input
                          type="checkbox"
                          checked={
                            Array.isArray(current) &&
                            current.includes(
                              field.numeric
                                ? Number(option.value)
                                : option.value,
                            )
                          }
                          onChange={(event) =>
                            change(
                              field.path,
                              event.target.checked
                                ? [
                                    ...(Array.isArray(current) ? current : []),
                                    field.numeric
                                      ? Number(option.value)
                                      : option.value,
                                  ]
                                : (Array.isArray(current)
                                    ? current
                                    : []
                                  ).filter(
                                    (v) =>
                                      v !==
                                      (field.numeric
                                        ? Number(option.value)
                                        : option.value),
                                  ),
                            )
                          }
                        />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
                ) : field.kind === "checkbox" ? (
                  <label className="form-check">
                    <input
                      {...common}
                      type="checkbox"
                      checked={current === true}
                      onChange={(event) =>
                        change(field.path, event.target.checked)
                      }
                    />
                    {field.label}
                  </label>
                ) : (
                  <>
                    <label htmlFor={id}>{field.label}</label>
                    {field.kind === "textarea" ? (
                      <textarea
                        {...common}
                        rows={4}
                        minLength={field.minLength}
                        maxLength={field.maxLength}
                        value={String(current ?? "")}
                        onChange={(event) =>
                          change(field.path, event.target.value)
                        }
                      />
                    ) : field.kind === "select" ? (
                      <Select
                        {...common}
                        value={String(current ?? "")}
                        onChange={(event) =>
                          change(
                            field.path,
                            field.numeric && event.target.value
                              ? Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      >
                        <option value="">
                          Select {field.label.toLowerCase()}
                        </option>
                        {field.options?.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <input
                        {...common}
                        type={field.kind ?? "text"}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        minLength={field.minLength}
                        maxLength={field.maxLength}
                        autoComplete={
                          field.kind === "password" ? "new-password" : undefined
                        }
                        value={String(current ?? "")}
                        onChange={(event) =>
                          change(
                            field.path,
                            field.kind === "number" && event.target.value !== ""
                              ? Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      />
                    )}
                  </>
                )}
                {field.help && (
                  <small id={`${id}-help`} className="muted">
                    {field.help}
                  </small>
                )}
                {issue && (
                  <span id={`${id}-error`} className="error">
                    {issue}
                  </span>
                )}
              </div>
            );
          })}
      </fieldset>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <ModalActions>
        <button type="submit" disabled={busy}>
          {busy ? pendingLabel : label}
        </button>
      </ModalActions>
    </form>
  );
}
