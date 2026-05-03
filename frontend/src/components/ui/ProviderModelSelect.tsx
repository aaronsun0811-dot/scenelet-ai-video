import { useState, useRef, useEffect, useCallback, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Check } from "lucide-react";
import { ProviderIcon } from "@/components/ui/ProviderIcon";

interface ProviderModelSelectProps {
  value: string; // "gemini-aistudio/veo-3.1-generate-001"
  options: string[]; // ["gemini-aistudio/veo-3.1-generate-001", ...]
  providerNames: Record<string, string>; // {"gemini-aistudio": "Gemini AI Studio", ...}
  optionLabels?: Record<string, string>; // {"provider/model": "Display label"}
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** If true, adds a default option that returns empty string */
  allowDefault?: boolean;
  /** Label for the default option */
  defaultLabel?: string;
  defaultHint?: string; // "当前: gemini-aistudio/veo-3.1-generate-001"
  /** When value is empty, show this "provider/model" as the effective fallback in the trigger */
  fallbackValue?: string;
  /** Accessible label for the trigger button */
  "aria-label"?: string;
}

interface FlatOption {
  type: "default" | "option";
  fullValue: string;
}

function groupByProvider(options: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const opt of options) {
    const slashIdx = opt.indexOf("/");
    if (slashIdx === -1) continue;
    const provider = opt.slice(0, slashIdx);
    const model = opt.slice(slashIdx + 1);
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(model);
  }
  return groups;
}

interface DropdownPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function ProviderModelSelect({
  value,
  options,
  providerNames,
  optionLabels,
  onChange,
  placeholder,
  className,
  allowDefault,
  defaultLabel,
  defaultHint,
  fallbackValue,
  "aria-label": ariaLabel,
}: ProviderModelSelectProps) {
  const { t } = useTranslation("dashboard");
  const resolvedPlaceholder = placeholder ?? t("select_model_placeholder");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const reactId = useId();
  const listboxId = `provider-model-listbox-${reactId.replaceAll(":", "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Memoize grouped so flatOptions below has a stable reference when options
  // hasn't changed; otherwise every render creates a new `grouped` object,
  // invalidates flatOptions, and resets activeIndex on the effect below,
  // breaking keyboard ArrowUp/ArrowDown navigation.
  const grouped = useMemo(() => groupByProvider(options), [options]);

  // Build a flat list of selectable options for keyboard navigation
  const flatOptions = useMemo(() => {
    const list: FlatOption[] = [];
    if (allowDefault) {
      list.push({ type: "default", fullValue: "" });
    }
    for (const [providerId, models] of Object.entries(grouped)) {
      for (const model of models) {
        list.push({
          type: "option",
          fullValue: `${providerId}/${model}`,
        });
      }
    }
    return list;
  }, [allowDefault, grouped]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = !!containerRef.current?.contains(target);
      const insideDropdown = !!dropdownRef.current?.contains(target);
      if (!insideTrigger && !insideDropdown) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Reset active index when opened — point to current value or 0
  useEffect(() => {
    if (open) {
      const idx = flatOptions.findIndex((o) => o.fullValue === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, flatOptions, value]);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const viewportPadding = 8;
    const preferredHeight = 240;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
    const availableHeight = Math.max(120, (openUp ? spaceAbove : spaceBelow) - gap);
    const maxHeight = Math.min(preferredHeight, availableHeight);
    setDropdownPosition({
      left: Math.max(viewportPadding, rect.left),
      top: openUp ? Math.max(viewportPadding, rect.top - maxHeight - gap) : rect.bottom + gap,
      width: rect.width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateDropdownPosition();
    window.addEventListener("resize", updateDropdownPosition);
    window.addEventListener("scroll", updateDropdownPosition, true);
    return () => {
      window.removeEventListener("resize", updateDropdownPosition);
      window.removeEventListener("scroll", updateDropdownPosition, true);
    };
  }, [open, updateDropdownPosition]);

  // Scroll active item into view
  useEffect(() => {
    if (open) {
      itemRefs.current.get(activeIndex)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const selectOption = useCallback(
    (optValue: string) => {
      onChange(optValue);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          updateDropdownPosition();
          setOpen(true);
          return;
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          if (flatOptions.length === 0) break;
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % flatOptions.length);
          break;
        case "ArrowUp":
          if (flatOptions.length === 0) break;
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + flatOptions.length) % flatOptions.length);
          break;
        case "Home":
          if (flatOptions.length === 0) break;
          e.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          if (flatOptions.length === 0) break;
          e.preventDefault();
          setActiveIndex(flatOptions.length - 1);
          break;
        case "Enter":
        case " ": {
          e.preventDefault();
          const opt = flatOptions[activeIndex];
          if (opt) selectOption(opt.fullValue);
          break;
        }
        case "Escape":
          e.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
          break;
      }
    },
    [open, flatOptions, activeIndex, selectOption, updateDropdownPosition],
  );

  const slashIdx = value ? value.indexOf("/") : -1;
  const currentProvider = slashIdx !== -1 ? value.slice(0, slashIdx) : "";
  const currentModel = slashIdx !== -1 ? value.slice(slashIdx + 1) : "";

  const fbSlashIdx = !value && fallbackValue ? fallbackValue.indexOf("/") : -1;
  const fbProvider = fbSlashIdx !== -1 ? fallbackValue!.slice(0, fbSlashIdx) : "";
  const fbModel = fbSlashIdx !== -1 ? fallbackValue!.slice(fbSlashIdx + 1) : "";
  const showFallback = !value && fbSlashIdx !== -1;

  const displayText = value
    ? optionLabels?.[value] ?? `${providerNames[currentProvider] || currentProvider} · ${currentModel}`
    : showFallback
      ? `${t("follow_global_default")} · ${
        optionLabels?.[fallbackValue!] ?? `${providerNames[fbProvider] || fbProvider} · ${fbModel}`
      }`
      : resolvedPlaceholder;

  const activeDescendantId =
    open && flatOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  // Track flat index across grouped rendering
  let flatIdx = allowDefault ? 1 : 0;

  return (
    <div ref={containerRef} className={`relative ${className || ""}`}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={activeDescendantId}
        aria-label={ariaLabel}
        onClick={() => {
          updateDropdownPosition();
          setOpen((next) => !next);
        }}
        onKeyDown={handleKeyDown}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-700 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800/80 focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
      >
        <span className={`truncate ${showFallback ? "text-gray-400" : ""}`}>{displayText}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown panel */}
      {open && dropdownPosition && createPortal(
        <div
          ref={dropdownRef}
          id={listboxId}
          role="listbox"
          aria-label={t("select_model_aria")}
          style={{
            left: dropdownPosition.left,
            top: dropdownPosition.top,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
          }}
          className="fixed z-[1000] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
        >
          {allowDefault && (
            <button
              ref={(el) => {
                if (el) itemRefs.current.set(0, el);
                else itemRefs.current.delete(0);
              }}
              id={`${listboxId}-option-0`}
              role="option"
              aria-selected={value === ""}
              type="button"
              onClick={() => selectOption("")}
              onMouseEnter={() => setActiveIndex(0)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                activeIndex === 0 ? "bg-gray-800 text-white" : "text-gray-300 hover:bg-gray-800/50"
              }`}
            >
              <span>{defaultLabel ?? t("follow_global_default")}</span>
              {defaultHint && (
                <span className="ml-auto text-xs text-gray-500">{defaultHint}</span>
              )}
            </button>
          )}

          {Object.entries(grouped).map(([providerId, models]) => (
            <div key={providerId} role="presentation">
              {/* Group header */}
              <div
                role="presentation"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-500 bg-gray-950/50"
              >
                <ProviderIcon providerId={providerId} className="h-3.5 w-3.5" />
                {providerNames[providerId] || providerId}
              </div>
              {/* Model options */}
              {models.map((model) => {
                const currentFlatIdx = flatIdx++;
                const fullValue = `${providerId}/${model}`;
                const optionLabel = optionLabels?.[fullValue] ?? model;
                const isSelected = fullValue === value;
                const isActive = currentFlatIdx === activeIndex;
                return (
                  <button
                    key={fullValue}
                    ref={(el) => {
                      if (el) itemRefs.current.set(currentFlatIdx, el);
                      else itemRefs.current.delete(currentFlatIdx);
                    }}
                    id={`${listboxId}-option-${currentFlatIdx}`}
                    role="option"
                    aria-selected={isSelected}
                    type="button"
                    onClick={() => selectOption(fullValue)}
                    onMouseEnter={() => setActiveIndex(currentFlatIdx)}
                    className={`flex w-full items-center gap-1.5 px-3 py-2 pl-6 text-left text-sm transition-colors ${
                      isActive
                        ? "bg-gray-800 text-white"
                        : "text-gray-300 hover:bg-gray-800/50"
                    }`}
                  >
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{optionLabel}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
