import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Modal } from "../../web/modal.tsx";
import { Select } from "../../web/select.tsx";
import { SuggestionInput } from "../../web/suggestion-input.tsx";

const zones = Array.from({ length: 40 }, (_, index) => ({
  value: `zone-${index}`,
  label: `Timezone ${index}`,
}));

function Fixture() {
  const [modal, setModal] = useState(false);
  const [value, setValue] = useState("a");
  const [saved, setSaved] = useState("");
  const [model, setModel] = useState("");
  return (
    <main>
      <button
        type="button"
        className="dropdown-trigger"
        aria-label="Workspace reference"
      >
        <span>Workspace</span>
      </button>
      <label htmlFor="controlled">Controlled</label>
      <Select
        id="controlled"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="a">Alpha</option>
        <option value="b" disabled>
          Blocked
        </option>
        <option value="c">Charlie</option>
      </Select>
      <Select aria-label="Disabled" disabled defaultValue="a">
        <option value="a">Alpha</option>
      </Select>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: SuggestionInput renders a labelable text input. */}
      <label>
        Model
        <SuggestionInput
          value={model}
          onChange={setModel}
          suggestions={["model-one", "model-two"]}
        />
      </label>
      <button type="button" onClick={() => setValue("c")}>
        Update selection
      </button>
      <button type="button" onClick={() => setModal(true)}>
        Open form
      </button>
      <output>{saved}</output>
      {modal && (
        <Modal title="Dropdown form" onClose={() => setModal(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(String(new FormData(event.currentTarget).get("zone")));
            }}
          >
            <label htmlFor="zone">Timezone</label>
            <Select id="zone" name="zone" required defaultValue="">
              <option value="">Choose timezone</option>
              <optgroup label="Suggested">
                <option value="UTC">UTC</option>
              </optgroup>
              <optgroup label="All timezones">
                {zones.map((zone) => (
                  <option key={zone.value} value={zone.value}>
                    {zone.label}
                  </option>
                ))}
              </optgroup>
            </Select>
            <button type="submit">Save form</button>
            <button type="reset">Reset form</button>
          </form>
        </Modal>
      )}
    </main>
  );
}

const root = document.getElementById("fixture");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(<Fixture />);
