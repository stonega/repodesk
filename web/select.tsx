import {
  type SelectHTMLAttributes,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check } from "reicon-react";
import { DropdownPopup } from "./dropdown-popup.tsx";

type Option = {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
};
type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "multiple" | "size"
>;

/** Native form values/validation with the workspace picker's accessible menu. */
export function Select({ children, id, className, ...props }: SelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [invalid, setInvalid] = useState("");
  const search = useRef({ text: "", time: 0 });
  const dismiss = useCallback(() => setOpen(false), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Read the native options after React applies option and value changes.
  useLayoutEffect(() => {
    const element = native.current;
    if (!element) return;
    setOptions(
      Array.from(element.options, (option) => ({
        value: option.value,
        label: option.label,
        disabled:
          option.disabled ||
          (option.parentElement instanceof HTMLOptGroupElement &&
            option.parentElement.disabled),
        group:
          option.parentElement instanceof HTMLOptGroupElement
            ? option.parentElement.label
            : undefined,
      })),
    );
    setValue(element.value);
  }, [children, props.value, props.defaultValue]);

  useLayoutEffect(() => {
    const element = native.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      // Wait for the reset event's default action to restore native values.
      timer = setTimeout(() => {
        if (element) setValue(element.value);
        setInvalid("");
        dismiss();
      });
    };
    element?.form?.addEventListener("reset", reset);
    return () => {
      clearTimeout(timer);
      element?.form?.removeEventListener("reset", reset);
    };
  }, [dismiss]);

  useLayoutEffect(() => {
    if (open)
      list.current
        ?.querySelector(`[id="${controlId}-option-${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, controlId]);

  const show = (last = false) => {
    if (native.current?.matches(":disabled")) return;
    const selected = options.findIndex(
      (option) => option.value === value && !option.disabled,
    );
    setActive(
      selected >= 0
        ? selected
        : last
          ? options.findLastIndex((option) => !option.disabled)
          : options.findIndex((option) => !option.disabled),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    const element = native.current;
    if (!option || option.disabled || !element || element.matches(":disabled"))
      return;
    element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    setValue(element.value);
    setInvalid("");
    dismiss();
    trigger.current?.focus();
  };

  return (
    <span className="dropdown-control">
      <button
        ref={trigger}
        id={controlId}
        type="button"
        role="combobox"
        className={`dropdown-trigger ${className ?? ""}`}
        value={value}
        disabled={props.disabled}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={
          [
            props["aria-describedby"],
            invalid ? `${controlId}-validation` : undefined,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={props["aria-invalid"] || !!invalid}
        aria-required={props.required}
        aria-haspopup="listbox"
        aria-expanded={open && !props.disabled}
        aria-controls={open ? `${controlId}-list` : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${controlId}-option-${active}` : undefined
        }
        onClick={() => (open ? dismiss() : show())}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          } else if (event.key === "Tab") dismiss();
          else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) choose(active);
            else show();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp"))
              show(event.key === "ArrowUp");
            else {
              setOpen(true);
              const direction =
                event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
              let next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : active + direction;
              while (options[next]?.disabled) next += direction;
              if (options[next]) setActive(next);
            }
          } else if (
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const now = Date.now();
            const text =
              (now - search.current.time < 600 ? search.current.text : "") +
              event.key.toLowerCase();
            search.current = { text, time: now };
            const match = options.findIndex(
              (option) =>
                !option.disabled && option.label.toLowerCase().startsWith(text),
            );
            if (match >= 0) {
              setActive(match);
              setOpen(true);
            }
          }
        }}
      >
        <span>
          {options.find((option) => option.value === value)?.label ??
            "Select an option"}
        </span>
      </button>
      <select
        {...props}
        ref={native}
        hidden
        aria-hidden="true"
        aria-label={undefined}
        aria-labelledby={undefined}
        aria-describedby={undefined}
        tabIndex={-1}
        onChange={(event) => {
          setValue(event.target.value);
          props.onChange?.(event);
        }}
        onInvalid={(event) => {
          event.preventDefault();
          setInvalid(event.currentTarget.validationMessage);
          trigger.current?.focus();
          props.onInvalid?.(event);
        }}
      >
        {children}
      </select>
      {invalid && (
        <small
          id={`${controlId}-validation`}
          role="alert"
          className="field-error"
        >
          {invalid}
        </small>
      )}
      {open && !props.disabled && (
        <DropdownPopup anchor={trigger} onDismiss={dismiss}>
          <div
            ref={list}
            id={`${controlId}-list`}
            role="listbox"
            aria-labelledby={controlId}
          >
            {options.map((option, index) => (
              <div key={`${option.group ?? ""}-${option.value}`}>
                {option.group && option.group !== options[index - 1]?.group && (
                  <div className="dropdown-group">{option.group}</div>
                )}
                <div
                  id={`${controlId}-option-${index}`}
                  role="option"
                  tabIndex={-1}
                  className="dropdown-item"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled}
                  data-value={option.value}
                  data-active={index === active}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      choose(index);
                    }
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value && (
                    <Check
                      aria-hidden="true"
                      size={20}
                      weight="Outline"
                      color="currentColor"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </DropdownPopup>
      )}
    </span>
  );
}
