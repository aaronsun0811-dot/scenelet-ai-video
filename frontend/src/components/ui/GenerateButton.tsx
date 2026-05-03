import { Sparkles, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { type GenerationPreflightConfig, useGenerationPreflightGate } from "@/components/ui/GenerationPreflight";

// ---------------------------------------------------------------------------
// GenerateButton — 带 framer-motion 平滑状态过渡的生成按钮
// ---------------------------------------------------------------------------

interface GenerateButtonProps {
  onClick: () => void | Promise<void>;
  loading?: boolean;
  label?: string;
  loadingLabel?: string;
  className?: string;
  disabled?: boolean;
  layoutId?: string;
  preflight?: GenerationPreflightConfig;
}

export function GenerateButton({
  onClick,
  loading = false,
  label = "生成",
  loadingLabel,
  className,
  disabled = false,
  layoutId,
  preflight,
}: GenerateButtonProps) {
  const { t } = useTranslation("dashboard");
  const {
    checkingGenerationPreflight,
    generationPreflightDialog,
    runWithGenerationPreflight,
  } = useGenerationPreflightGate();
  const isDisabled = disabled || loading || checkingGenerationPreflight;
  const effectiveLoadingLabel = checkingGenerationPreflight
    ? t("generation_preflight_checking")
    : loadingLabel ?? t("generating_status");
  const isBusy = loading || checkingGenerationPreflight;

  const handleClick = async () => {
    await runWithGenerationPreflight(preflight, onClick);
  };

  return (
    <>
      <motion.button
        type="button"
        layout
        layoutId={layoutId}
        onClick={() => void handleClick()}
        disabled={isDisabled}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors ${
          isBusy
            ? "bg-indigo-700"
            : "bg-indigo-600 hover:bg-indigo-500"
        } ${isDisabled ? "cursor-not-allowed opacity-50" : ""} ${className ?? ""}`}
        animate={
          isBusy
            ? { opacity: [0.7, 1, 0.7] }
            : { opacity: isDisabled ? 0.5 : 1 }
        }
        transition={
          isBusy
            ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.3 }
        }
      >
        <AnimatePresence mode="wait" initial={false}>
          {isBusy ? (
            <motion.span
              key="loader"
              initial={{ opacity: 0, rotate: -90 }}
              animate={{ opacity: 1, rotate: 0 }}
              exit={{ opacity: 0, rotate: 90 }}
              transition={{ duration: 0.2 }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </motion.span>
          ) : (
            <motion.span
              key="sparkles"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.2 }}
            >
              <Sparkles className="h-4 w-4" />
            </motion.span>
          )}
        </AnimatePresence>
        <span>{isBusy ? effectiveLoadingLabel : label}</span>
      </motion.button>
      {generationPreflightDialog}
    </>
  );
}
