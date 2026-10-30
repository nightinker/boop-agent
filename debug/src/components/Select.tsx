import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

const MENU_MAX_HEIGHT = 288;

/**
 * Dashboard dropdown. Unlike a native <select>, the menu always opens directly
 * under (or above) the trigger at its width, so it lines up with the field
 * instead of centering the selected item over it the way macOS does.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  isDark,
  placeholder = "Select…",
  disabled = false,
  ariaLabel,
  size = "md",
  className = "",
}: {
  value: T | "";
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  isDark: boolean;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [openUpward, setOpenUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setOpenUpward(below < Math.min(MENU_MAX_HEIGHT, options.length * 36 + 8) && rect.top > below);
  }, [open, options.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function openMenu() {
    if (disabled) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (option.value !== value) onChange(option.value);
  }

  function jumpByTyping(key: string) {
    const now = Date.now();
    typeahead.current.text =
      now - typeahead.current.at > 600 ? key : typeahead.current.text + key;
    typeahead.current.at = now;
    const query = typeahead.current.text.toLowerCase();
    const match = options.findIndex((option) => option.label.toLowerCase().startsWith(query));
    if (match >= 0) setActiveIndex(match);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(options.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (event.key.length === 1) jumpByTyping(event.key);
    }
  }

  const padding = size === "sm" ? "px-2.5 py-1.5" : "px-3 py-2";
  const trigger = isDark
    ? "border-white/10 bg-[#17171a] text-zinc-100 hover:border-white/20"
    : "border-zinc-200 bg-zinc-50 text-zinc-900 hover:border-zinc-300";
  const focus = isDark ? "focus-visible:border-zinc-400" : "focus-visible:border-zinc-500";
  const menu = isDark
    ? "border-white/10 bg-[#1c1c20] shadow-black/40"
    : "border-zinc-200 bg-white shadow-zinc-300/50";
  const optionActive = isDark ? "bg-white/10" : "bg-zinc-100";
  const muted = isDark ? "text-zinc-500" : "text-zinc-400";

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center gap-2 rounded-xl border text-left text-xs outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${padding} ${trigger} ${focus}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "" : muted}`}>
          {selected?.label ?? placeholder}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={14}
          className={`shrink-0 transition-transform ${muted} ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          style={{ maxHeight: MENU_MAX_HEIGHT }}
          className={`absolute left-0 right-0 z-50 overflow-auto rounded-xl border p-1 shadow-lg fade-in ${menu} ${
            openUpward ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={isSelected}
                onPointerEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                  index === activeIndex ? optionActive : ""
                } ${isDark ? "text-zinc-200" : "text-zinc-800"}`}
              >
                <span className="flex w-3.5 shrink-0 justify-center">
                  {isSelected && <HugeiconsIcon icon={Tick02Icon} size={14} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
