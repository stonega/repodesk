import { useEffect, useId, useRef, useState } from "react";

type RepositoryOption = { id: number; full_name: string };

export function RepositorySelect({
  repositories,
  value,
  onChange,
}: {
  repositories: RepositoryOption[];
  value: number;
  onChange: (id: number) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = repositories.find((repository) => repository.id === value);
  const matches = repositories.filter((repository) =>
    repository.full_name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const activeOption = matches[active];

  useEffect(() => {
    input.current?.setCustomValidity(
      selected ? "" : "Select a connected repository from the list.",
    );
  }, [selected]);

  useEffect(() => {
    if (open && activeOption)
      list.current
        ?.querySelector(`[data-repository-id="${activeOption.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, activeOption]);

  const show = () => {
    setQuery("");
    setActive(
      Math.max(
        0,
        repositories.findIndex((r) => r.id === value),
      ),
    );
    setOpen(true);
  };
  const choose = (repository: RepositoryOption) => {
    onChange(repository.id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="field repository-select">
      <label htmlFor={id}>Repository</label>
      <input
        ref={input}
        id={id}
        role="combobox"
        required
        autoComplete="off"
        spellCheck={false}
        placeholder="Search connected repositories"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={
          open && activeOption ? `${id}-option-${activeOption.id}` : undefined
        }
        value={open ? query : (selected?.full_name ?? "")}
        onClick={() => {
          if (!open) show();
        }}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) show();
            else
              setActive((index) =>
                Math.max(
                  0,
                  Math.min(
                    matches.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (activeOption) choose(activeOption);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (open && (event.key === "Home" || event.key === "End")) {
            event.preventDefault();
            setActive(
              event.key === "Home" ? 0 : Math.max(0, matches.length - 1),
            );
          }
        }}
      />
      {open && (
        <div className="repository-select-popup">
          <div
            ref={list}
            className="repository-select-list"
            id={`${id}-list`}
            role="listbox"
            aria-label="Repositories"
          >
            {matches.map((repository, index) => (
              <button
                type="button"
                tabIndex={-1}
                key={repository.id}
                id={`${id}-option-${repository.id}`}
                role="option"
                aria-selected={repository.id === value}
                data-repository-id={repository.id}
                data-active={index === active}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(repository)}
              >
                {repository.full_name}
              </button>
            ))}
          </div>
          {!matches.length && (
            <p role="status">
              {repositories.length
                ? "No repositories match your search."
                : "No connected repositories available."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
