import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check } from "reicon-react";
import { DropdownPopup } from "./dropdown-popup.tsx";

/** A styled suggestion menu that continues to accept arbitrary typed values. */
export function SuggestionInput({
  value,
  suggestions,
  placeholder,
  onChange,
}: {
  value: string;
  suggestions: string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const dismiss = useCallback(() => setOpen(false), []);
  const matches = suggestions.filter((option) =>
    option.toLowerCase().includes(value.trim().toLowerCase()),
  );
  const expanded = open && matches.length > 0;
  const choose = (option: string) => {
    onChange(option);
    dismiss();
    input.current?.focus();
  };
  useEffect(() => {
    if (expanded)
      list.current
        ?.querySelector(`[id="${id}-option-${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [expanded, active, id]);
  return (
    <span className="dropdown-search-control">
      <input
        ref={input}
        className="dropdown-trigger"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={
          expanded && matches[active] ? `${id}-option-${active}` : undefined
        }
        value={value}
        placeholder={placeholder}
        onClick={() => {
          setActive(-1);
          setOpen(true);
        }}
        onBlur={dismiss}
        onChange={(event) => {
          onChange(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive((index) =>
              Math.max(
                0,
                Math.min(
                  matches.length - 1,
                  index + (event.key === "ArrowDown" ? 1 : -1),
                ),
              ),
            );
          } else if (event.key === "Enter" && expanded && matches[active]) {
            event.preventDefault();
            choose(matches[active]);
          }
        }}
      />
      {expanded && (
        <DropdownPopup anchor={input} onDismiss={dismiss}>
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label="Suggestions"
          >
            {matches.map((option, index) => (
              <button
                key={option}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                className="dropdown-item"
                aria-selected={option === value}
                data-active={index === active}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <span>{option}</span>
                {option === value && (
                  <Check
                    aria-hidden="true"
                    size={20}
                    weight="Outline"
                    color="currentColor"
                  />
                )}
              </button>
            ))}
          </div>
        </DropdownPopup>
      )}
    </span>
  );
}
