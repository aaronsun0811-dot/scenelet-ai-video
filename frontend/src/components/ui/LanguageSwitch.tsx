import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normalizeLanguage, SUPPORTED_LANGUAGES } from "@/i18n/languages";

interface LanguageSwitchProps {
  className?: string;
  showLabel?: boolean;
}

export function LanguageSwitch({ className = "", showLabel = false }: LanguageSwitchProps) {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage || i18n.language);

  return (
    <label
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-800 bg-gray-900/70 px-2.5 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-700 hover:bg-gray-800 hover:text-white ${className}`}
      title={t("dashboard:language_setting")}
    >
      <Languages className="h-4 w-4" />
      <span className={showLabel ? "" : "sr-only"}>{t("dashboard:language_setting")}</span>
      <select
        value={currentLanguage}
        onChange={(event) => {
          void i18n.changeLanguage(event.target.value);
        }}
        className="cursor-pointer appearance-none bg-transparent text-xs font-semibold uppercase tracking-normal text-gray-200 outline-none"
        aria-label={t("dashboard:language_setting")}
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language.code} value={language.code} className="bg-gray-900 text-gray-100">
            {language.shortLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
