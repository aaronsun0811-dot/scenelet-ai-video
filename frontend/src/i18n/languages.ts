export type SupportedLanguage = "zh" | "en" | "ja";

export const SUPPORTED_LANGUAGES: {
  code: SupportedLanguage;
  labelKey: "common:chinese" | "common:english" | "common:japanese";
  shortLabel: string;
}[] = [
  { code: "zh", labelKey: "common:chinese", shortLabel: "ZH" },
  { code: "en", labelKey: "common:english", shortLabel: "EN" },
  { code: "ja", labelKey: "common:japanese", shortLabel: "JA" },
];

export function normalizeLanguage(language?: string): SupportedLanguage {
  const base = (language || "zh").split("-")[0]?.toLowerCase();
  if (base === "en" || base === "ja" || base === "zh") return base;
  return "zh";
}

export function getNextLanguage(language?: string): SupportedLanguage {
  const current = normalizeLanguage(language);
  const index = SUPPORTED_LANGUAGES.findIndex((item) => item.code === current);
  return SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length].code;
}
