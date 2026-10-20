import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Modal } from "../../web/modal.tsx";
import { PluginToggle } from "../../web/plugin-detail.tsx";
import { RecordForm } from "../../web/record-form.tsx";

function Fixture() {
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [member, setMember] = useState(false);
  const [saved, setSaved] = useState({ review: false, tools: ["metadata"] });
  return (
    <main style={{ maxWidth: 640, margin: "24px auto", padding: 16 }}>
      <h1>Checkbox choices</h1>
      <section className="card">
        <h2>Resource selection</h2>
        <label className="check">
          <input type="checkbox" />
          <span>example.com</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" defaultChecked />
          organization/repository-with-a-long-name-that-wraps-on-small-screens
        </label>
        <label className="plugin-check">
          <input type="checkbox" disabled defaultChecked />
          <span>Already imported</span>
        </label>
        <label className="check">
          <input type="checkbox" disabled />
          <span>Unavailable choice</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            ref={(input) => {
              if (input) input.indeterminate = true;
            }}
          />
          <span>Some repositories selected</span>
        </label>
      </section>
      <section className="card" aria-label="Saved configuration">
        <h2>Saved configuration</h2>
        <p>Automatic review: {saved.review ? "On" : "Off"}</p>
        <p>Tools: {saved.tools.join(", ")}</p>
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      </section>
      <section className="card">
        <h2>Enable switch</h2>
        <PluginToggle
          name="Example plugin"
          enabled={enabled}
          disabled={false}
          onChange={setEnabled}
        />
        <label className="member-toggle-row">
          <span>Active membership</span>
          <input
            className="member-toggle-input"
            type="checkbox"
            role="switch"
            checked={member}
            aria-checked={member}
            onChange={(event) => setMember(event.target.checked)}
          />
        </label>
      </section>
      {editing && (
        <Modal title="Edit configuration" onClose={() => setEditing(false)}>
          <RecordForm
            value={saved}
            fields={[
              { path: "review", label: "Automatic review", kind: "checkbox" },
              {
                path: "tools",
                label: "Tools",
                kind: "choices",
                options: [
                  { value: "metadata", label: "Repository metadata" },
                  {
                    value: "contents",
                    label:
                      "Read repository contents and configuration from connected repositories",
                  },
                ],
              },
            ]}
            save={async (value) => {
              await new Promise<void>((resolve, reject) => {
                window.addEventListener(
                  "checkbox-save",
                  (event) => {
                    if ((event as CustomEvent).detail === "reject")
                      reject(new Error("Save failed. Try again."));
                    else resolve();
                  },
                  { once: true },
                );
              });
              setSaved(value as typeof saved);
              setEditing(false);
            }}
          />
        </Modal>
      )}
    </main>
  );
}

const root = document.getElementById("fixture");
if (root) createRoot(root).render(<Fixture />);
