import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, MapPinned, Trash2, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { errMsg } from "@/utils/async";
import { useWarnUnsaved } from "@/hooks/useWarnUnsaved";
import type { SystemConfigPatch, SystemConfigSettings } from "@/types/system";

type MapSettingKey = "google_maps_api_key" | "baidu_maps_api_key" | "amap_maps_api_key";

type MapProviderConfig = {
  provider: "google" | "baidu" | "amap";
  settingKey: MapSettingKey;
  titleKey: string;
  descKey: string;
  labelKey: string;
  placeholderKey: string;
  helpKey: string;
  notSetKey: string;
  saveKey: string;
  clearKey: string;
  savedKey: string;
  clearedKey: string;
};

const MAP_PROVIDERS: MapProviderConfig[] = [
  {
    provider: "google",
    settingKey: "google_maps_api_key",
    titleKey: "dashboard:google_maps_provider_title",
    descKey: "dashboard:google_maps_provider_desc",
    labelKey: "dashboard:google_maps_api_key_label",
    placeholderKey: "dashboard:google_maps_api_key_placeholder",
    helpKey: "dashboard:google_maps_api_key_help",
    notSetKey: "dashboard:google_maps_api_key_not_set",
    saveKey: "dashboard:google_maps_save",
    clearKey: "dashboard:google_maps_clear",
    savedKey: "dashboard:google_maps_config_saved",
    clearedKey: "dashboard:google_maps_config_cleared",
  },
  {
    provider: "baidu",
    settingKey: "baidu_maps_api_key",
    titleKey: "dashboard:baidu_maps_provider_title",
    descKey: "dashboard:baidu_maps_provider_desc",
    labelKey: "dashboard:baidu_maps_api_key_label",
    placeholderKey: "dashboard:baidu_maps_api_key_placeholder",
    helpKey: "dashboard:baidu_maps_api_key_help",
    notSetKey: "dashboard:baidu_maps_api_key_not_set",
    saveKey: "dashboard:baidu_maps_save",
    clearKey: "dashboard:baidu_maps_clear",
    savedKey: "dashboard:baidu_maps_config_saved",
    clearedKey: "dashboard:baidu_maps_config_cleared",
  },
  {
    provider: "amap",
    settingKey: "amap_maps_api_key",
    titleKey: "dashboard:amap_maps_provider_title",
    descKey: "dashboard:amap_maps_provider_desc",
    labelKey: "dashboard:amap_maps_api_key_label",
    placeholderKey: "dashboard:amap_maps_api_key_placeholder",
    helpKey: "dashboard:amap_maps_api_key_help",
    notSetKey: "dashboard:amap_maps_api_key_not_set",
    saveKey: "dashboard:amap_maps_save",
    clearKey: "dashboard:amap_maps_clear",
    savedKey: "dashboard:amap_maps_config_saved",
    clearedKey: "dashboard:amap_maps_config_cleared",
  },
];

export function TravelMapSettingsSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const [settings, setSettings] = useState<SystemConfigSettings | null>(null);
  const [apiKeys, setApiKeys] = useState<Partial<Record<MapSettingKey, string>>>({});
  const [loading, setLoading] = useState(false);
  const [savingProvider, setSavingProvider] = useState<MapSettingKey | null>(null);
  const [testingProvider, setTestingProvider] = useState<MapSettingKey | null>(null);
  const isDirty = Object.values(apiKeys).some((value) => (value ?? "").trim().length > 0);

  useWarnUnsaved(isDirty);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await API.getSystemConfig();
      setSettings(res.settings);
      setApiKeys({});
    } catch (err) {
      useAppStore.getState().pushToast(t("dashboard:maps_config_load_failed", { message: errMsg(err) }), "warning");
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const updateDraft = (settingKey: MapSettingKey, value: string) => {
    setApiKeys((prev) => ({ ...prev, [settingKey]: value }));
  };

  const saveKey = async (provider: MapProviderConfig, nextKey: string) => {
    setSavingProvider(provider.settingKey);
    try {
      const patch = { [provider.settingKey]: nextKey } as SystemConfigPatch;
      const res = await API.updateSystemConfig(patch);
      setSettings(res.settings);
      setApiKeys((prev) => ({ ...prev, [provider.settingKey]: "" }));
      useAppStore.getState().pushToast(
        nextKey ? t(provider.savedKey) : t(provider.clearedKey),
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(t("dashboard:maps_config_save_failed", { message: errMsg(err) }), "error");
    } finally {
      setSavingProvider(null);
    }
  };

  const testKey = async (provider: MapProviderConfig, draftKey: string) => {
    setTestingProvider(provider.settingKey);
    try {
      const res = await API.testMapProvider({
        provider: provider.provider,
        ...(draftKey.trim() ? { api_key: draftKey.trim() } : {}),
      });
      useAppStore.getState().pushToast(
        res.message || (res.success ? t("dashboard:maps_test_success") : t("dashboard:maps_test_failed")),
        res.success ? "success" : "warning",
      );
    } catch (err) {
      useAppStore.getState().pushToast(t("dashboard:maps_test_failed_with_message", { message: errMsg(err) }), "error");
    } finally {
      setTestingProvider(null);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-100">{t("dashboard:maps_settings_title")}</h2>
        <p className="mt-1 text-sm leading-6 text-gray-500">{t("dashboard:maps_settings_desc")}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {MAP_PROVIDERS.map((provider) => {
          const status = settings?.[provider.settingKey];
          const configured = Boolean(status?.is_set);
          const masked = status?.masked;
          const draft = apiKeys[provider.settingKey] ?? "";
          const saving = savingProvider === provider.settingKey;
          const testing = testingProvider === provider.settingKey;
          const canSave = draft.trim().length > 0 && !savingProvider;
          const canTest = (draft.trim().length > 0 || configured) && !savingProvider && !testingProvider;

          return (
            <section key={provider.settingKey} className="rounded-xl border border-gray-800 bg-gray-950/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-100">
                    <MapPinned className="h-4 w-4 text-indigo-300" />
                    {t(provider.titleKey)}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{t(provider.descKey)}</p>
                  <p className={`mt-2 text-xs font-medium ${configured ? "text-emerald-300" : "text-amber-300"}`}>
                    {configured
                      ? t("dashboard:maps_api_configured", { provider: t(provider.titleKey) })
                      : t("dashboard:maps_api_optional_missing", { provider: t(provider.titleKey) })}
                  </p>
                </div>
                {configured ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" />
                ) : (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-300" />
                )}
              </div>

              <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                <div className="text-xs text-gray-500">{t("dashboard:maps_current_key")}</div>
                <div className="mt-2 min-h-5 font-mono text-sm text-gray-100">
                  {loading ? t("common:loading") : masked ?? t(provider.notSetKey)}
                </div>
                <p className="mt-2 text-xs leading-5 text-gray-500">{t(provider.helpKey)}</p>
              </div>

              <label className="mt-4 block">
                <span className="flex items-center gap-2 text-sm font-medium text-gray-100">
                  <KeyRound className="h-4 w-4" />
                  {t(provider.labelKey)}
                </span>
                <input
                  type="password"
                  value={draft}
                  onChange={(event) => updateDraft(provider.settingKey, event.target.value)}
                  placeholder={configured ? t("dashboard:maps_keep_existing_hint") : t(provider.placeholderKey)}
                  aria-label={t(provider.labelKey)}
                  className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
                />
              </label>

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void saveKey(provider, draft.trim())}
                  disabled={!canSave}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {saving ? t("dashboard:maps_saving") : t(provider.saveKey)}
                </button>
                {configured && (
                  <button
                    type="button"
                    onClick={() => void saveKey(provider, "")}
                    disabled={Boolean(savingProvider)}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {t(provider.clearKey)}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void testKey(provider, draft)}
                  disabled={!canTest}
                  className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 px-4 py-2 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
                  {testing ? t("dashboard:maps_testing") : t("dashboard:maps_test_connection")}
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <div className="rounded-xl border border-cyan-300/20 bg-cyan-500/5 p-4 text-sm leading-6 text-cyan-100/80">
        {t("dashboard:maps_generation_rule")}
      </div>
    </div>
  );
}
