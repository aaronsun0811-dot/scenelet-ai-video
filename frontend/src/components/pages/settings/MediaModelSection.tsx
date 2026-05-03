import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSearch } from "wouter";
import { Download, FileText, Loader2, Upload } from "lucide-react";
import { useWarnUnsaved } from "@/hooks/useWarnUnsaved";
import { API } from "@/api";
import type {
  ModelRuleConfig,
  ModelRuleMode,
  ModelSkillRuntime,
  SystemConfigOptions,
  SystemConfigPatch,
  SystemConfigSettings,
} from "@/types/system";
import { ProviderModelSelect } from "@/components/ui/ProviderModelSelect";
import { PROVIDER_NAMES } from "@/components/ui/ProviderIcon";
import { useAppStore } from "@/stores/app-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { errMsg } from "@/utils/async";

const RULE_MODES: ModelRuleMode[] = ["default", "prompt", "github_skill", "uploaded_skill"];
const SKILL_RUNTIMES: ModelSkillRuntime[] = ["openai", "hermes_agent", "openclaw", "claude_code"];
const MEDIA_RULE_PROVIDER_ID = "__media__";
const MEDIA_RULE_TARGETS = {
  image: `${MEDIA_RULE_PROVIDER_ID}/image`,
  video: `${MEDIA_RULE_PROVIDER_ID}/video`,
} as const;

function normalizeRuleConfig(config?: ModelRuleConfig): ModelRuleConfig {
  if (!config || !RULE_MODES.includes(config.mode)) {
    return { mode: "default" };
  }
  return {
    mode: config.mode,
    prompt: config.prompt ?? "",
    skill_runtime: config.skill_runtime ?? "openai",
    skill_github_url: config.skill_github_url ?? "",
    skill_name: config.skill_name ?? "",
    skill_content: config.skill_content ?? "",
  };
}

function constrainRuleConfig(config: ModelRuleConfig): ModelRuleConfig {
  const normalized = normalizeRuleConfig(config);
  if (normalized.mode === "default") {
    return { mode: "default" };
  }
  if (normalized.mode === "prompt") {
    return {
      mode: "prompt",
      prompt: normalized.prompt ?? "",
    };
  }
  if (normalized.mode === "github_skill") {
    return {
      mode: "github_skill",
      skill_runtime: normalized.skill_runtime ?? "openai",
      skill_github_url: normalized.skill_github_url ?? "",
      skill_name: normalized.skill_name ?? "",
      skill_content: normalized.skill_content ?? "",
    };
  }
  return {
    mode: "uploaded_skill",
    skill_runtime: normalized.skill_runtime ?? "openai",
    skill_name: normalized.skill_name ?? "",
    skill_content: normalized.skill_content ?? "",
  };
}

function switchRuleMode(current: ModelRuleConfig, mode: ModelRuleMode): ModelRuleConfig {
  const normalized = normalizeRuleConfig(current);
  return constrainRuleConfig({ ...normalized, mode });
}

function formatModelLabel(value: string, providerNames: Record<string, string>): string {
  const slashIdx = value.indexOf("/");
  if (slashIdx === -1) return value;
  const providerId = value.slice(0, slashIdx);
  const modelId = value.slice(slashIdx + 1);
  return `${providerNames[providerId] || providerId} · ${modelId}`;
}

function isMediaRuleTarget(value: string): boolean {
  return value === MEDIA_RULE_TARGETS.image || value === MEDIA_RULE_TARGETS.video;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaModelSection() {
  const { t } = useTranslation("dashboard");
  const search = useSearch();

  const TEXT_MODEL_FIELDS = useMemo(() => [
    ["text_backend_script", t("script_generation")],
    ["text_backend_overview", t("overview_generation")],
    ["text_backend_style", t("style_analysis")],
  ] as const, [t]);

  const [settings, setSettings] = useState<SystemConfigSettings | null>(null);
  const [options, setOptions] = useState<SystemConfigOptions | null>(null);
  const [draft, setDraft] = useState<SystemConfigPatch>({});
  const [saving, setSaving] = useState(false);
  const [importingSkillFor, setImportingSkillFor] = useState<string | null>(null);
  const [ruleModel, setRuleModel] = useState("");
  const requestedRuleTarget = useMemo(() => {
    return new URLSearchParams(search).get("ruleTarget")?.trim() ?? "";
  }, [search]);

  const isDirty = Object.keys(draft).length > 0;
  useWarnUnsaved(isDirty);

  const allProviderNames = useMemo(
    () => ({ ...PROVIDER_NAMES, ...(options?.provider_names ?? {}) }),
    [options],
  );

  const formatRuleTargetLabel = useCallback((value: string) => {
    if (value === MEDIA_RULE_TARGETS.image) return t("model_rule_target_image_generation");
    if (value === MEDIA_RULE_TARGETS.video) return t("model_rule_target_video_generation");
    return formatModelLabel(value, allProviderNames);
  }, [allProviderNames, t]);

  const fetchConfig = useCallback(async () => {
    const res = await API.getSystemConfig();
    setSettings(res.settings);
    setOptions(res.options);
    setDraft({});
  }, []);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const validateRuleConfigs = useCallback((configs: Record<string, ModelRuleConfig>): string | null => {
    for (const [model, rawConfig] of Object.entries(configs)) {
      const config = normalizeRuleConfig(rawConfig);
      const label = formatRuleTargetLabel(model);
      if (config.mode === "prompt" && !config.prompt?.trim()) {
        return t("model_rule_prompt_required", { model: label });
      }
      if (config.mode === "github_skill" && !config.skill_github_url?.trim()) {
        return t("model_rule_github_required", { model: label });
      }
      if (config.mode === "uploaded_skill" && !config.skill_content?.trim()) {
        return t("model_rule_upload_required", { model: label });
      }
    }
    return null;
  }, [formatRuleTargetLabel, t]);

  const handleSave = useCallback(async () => {
    if (Object.keys(draft).length === 0) return;
    const ruleConfigsForSave = draft.model_rule_configs ?? settings?.model_rule_configs ?? {};
    const ruleError = validateRuleConfigs(ruleConfigsForSave);
    if (ruleError) {
      useAppStore.getState().pushToast(ruleError, "error");
      return;
    }

    setSaving(true);
    try {
      await API.updateSystemConfig(draft);
      await fetchConfig();
      void useConfigStatusStore.getState().refresh();
      useAppStore.getState().pushToast(t("media_config_saved"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(t("save_failed", { message: errMsg(err) }), "error");
    } finally {
      setSaving(false);
    }
  }, [draft, fetchConfig, settings?.model_rule_configs, t, validateRuleConfigs]);

  const updateRuleConfig = useCallback((
    model: string,
    updater: (current: ModelRuleConfig) => ModelRuleConfig,
  ) => {
    setDraft((prev) => {
      const base = prev.model_rule_configs ?? settings?.model_rule_configs ?? {};
      const nextConfig = constrainRuleConfig(updater(normalizeRuleConfig(base[model])));
      return {
        ...prev,
        model_rule_configs: {
          ...base,
          [model]: nextConfig,
        },
      };
    });
  }, [settings?.model_rule_configs]);

  const handleImportGithubSkill = useCallback(async (model: string) => {
    const base = draft.model_rule_configs ?? settings?.model_rule_configs ?? {};
    const config = normalizeRuleConfig(base[model]);
    const rawInput = config.skill_github_url?.trim();
    if (!rawInput) {
      useAppStore.getState().pushToast(t("model_rule_github_required", {
        model: formatRuleTargetLabel(model),
      }), "error");
      return;
    }

    setImportingSkillFor(model);
    try {
      const imported = await API.importGithubSkill({ url: rawInput });
      updateRuleConfig(model, (current) => ({
        ...current,
        mode: "github_skill",
        skill_github_url: rawInput,
        skill_name: imported.skill_name,
        skill_content: imported.skill_content,
      }));
      useAppStore.getState().pushToast(t("model_rule_github_imported"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(t("model_rule_github_import_failed", {
        message: errMsg(err),
      }), "error");
    } finally {
      setImportingSkillFor(null);
    }
  }, [draft.model_rule_configs, formatRuleTargetLabel, settings?.model_rule_configs, t, updateRuleConfig]);

  const handleUploadSkill = useCallback(async (model: string, file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      updateRuleConfig(model, (current) => ({
        ...current,
        mode: "uploaded_skill",
        skill_name: file.name,
        skill_content: content,
      }));
      useAppStore.getState().pushToast(t("model_rule_upload_loaded"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(t("model_rule_upload_failed", {
        message: errMsg(err),
      }), "error");
    }
  }, [t, updateRuleConfig]);

  const videoBackends = useMemo(() => options?.video_backends ?? [], [options?.video_backends]);
  const imageBackends = useMemo(() => options?.image_backends ?? [], [options?.image_backends]);
  const textBackends = useMemo(() => options?.text_backends ?? [], [options?.text_backends]);

  const currentVideo = draft.default_video_backend ?? settings?.default_video_backend ?? "";
  const currentImage = draft.default_image_backend ?? settings?.default_image_backend ?? "";
  const currentAudio = draft.video_generate_audio ?? settings?.video_generate_audio ?? false;
  const ruleConfigs = useMemo(
    () => draft.model_rule_configs ?? settings?.model_rule_configs ?? {},
    [draft.model_rule_configs, settings?.model_rule_configs],
  );
  const mediaRuleTargets = useMemo(() => [
    ...(imageBackends.length > 0 ? [MEDIA_RULE_TARGETS.image] : []),
    ...(videoBackends.length > 0 ? [MEDIA_RULE_TARGETS.video] : []),
  ], [imageBackends.length, videoBackends.length]);
  const mediaRuleOptionLabels = useMemo(() => ({
    [MEDIA_RULE_TARGETS.image]: t("model_rule_target_image_generation"),
    [MEDIA_RULE_TARGETS.video]: t("model_rule_target_video_generation"),
  }), [t]);
  const selectedModels = useMemo(() => Array.from(new Set([
    currentVideo,
    currentImage,
    ...TEXT_MODEL_FIELDS.map(([key]) => draft[key] ?? settings?.[key] ?? ""),
  ].filter(Boolean))), [TEXT_MODEL_FIELDS, currentImage, currentVideo, draft, settings]);
  const allRuleModels = useMemo(() => Array.from(new Set([
    ...mediaRuleTargets,
    ...selectedModels,
    ...videoBackends,
    ...imageBackends,
    ...textBackends,
    ...Object.keys(ruleConfigs),
  ].filter(Boolean))), [imageBackends, mediaRuleTargets, ruleConfigs, selectedModels, textBackends, videoBackends]);

  useEffect(() => {
    if (allRuleModels.length === 0) {
      if (ruleModel) setRuleModel("");
      return;
    }
    if (requestedRuleTarget && allRuleModels.includes(requestedRuleTarget)) {
      if (ruleModel !== requestedRuleTarget) {
        setRuleModel(requestedRuleTarget);
      }
      return;
    }
    if (!ruleModel || !allRuleModels.includes(ruleModel)) {
      setRuleModel(mediaRuleTargets[0] ?? selectedModels[0] ?? allRuleModels[0] ?? "");
    }
  }, [allRuleModels, mediaRuleTargets, requestedRuleTarget, ruleModel, selectedModels]);

  const renderInlineRuleControls = (model: string, scope: string) => {
    const config = normalizeRuleConfig(ruleConfigs[model]);
    const modelLabel = formatRuleTargetLabel(model);
    return (
      <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-gray-400">{t("model_rule_inline_title")}</div>
            <div className="mt-0.5 text-sm font-semibold text-gray-100">{modelLabel}</div>
          </div>
          <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-xs text-indigo-200">
            {t(`model_rule_mode_${config.mode}`)}
          </span>
        </div>

        <div
          className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
          role="radiogroup"
          aria-label={t("model_rule_source_aria", { model: modelLabel })}
        >
          {RULE_MODES.map((mode) => (
            <label
              key={mode}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                config.mode === mode
                  ? "border-indigo-500/70 bg-indigo-500/15 text-indigo-100"
                  : "border-gray-800 bg-gray-900/40 text-gray-400 hover:border-gray-700 hover:text-gray-200"
              }`}
            >
              <input
                type="radio"
                name={`model-rule-${scope}`}
                checked={config.mode === mode}
                onChange={() => updateRuleConfig(model, (current) => switchRuleMode(current, mode))}
                className="h-3.5 w-3.5 border-gray-600 bg-gray-900 text-indigo-500"
              />
              {t(`model_rule_mode_${mode}`)}
            </label>
          ))}
        </div>

        {config.mode === "prompt" && (
          <div className="mt-3">
            <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-prompt-${scope}`}>
              {t("model_rule_prompt_label")}
            </label>
            <textarea
              id={`model-rule-prompt-${scope}`}
              value={config.prompt ?? ""}
              onChange={(e) => updateRuleConfig(model, (current) => ({
                ...current,
                mode: "prompt",
                prompt: e.target.value,
              }))}
              placeholder={t("model_rule_prompt_placeholder")}
              className="min-h-24 w-full resize-y rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-indigo-500/70 focus-ring"
            />
          </div>
        )}

        {config.mode === "github_skill" && (
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
              <div>
                <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-github-${scope}`}>
                  {t("model_rule_github_url")}
                </label>
                <input
                  id={`model-rule-github-${scope}`}
                  type="url"
                  value={config.skill_github_url ?? ""}
                  onChange={(e) => updateRuleConfig(model, (current) => ({
                    ...current,
                    mode: "github_skill",
                    skill_github_url: e.target.value,
                  }))}
                  placeholder="https://github.com/org/repo/blob/main/SKILL.md"
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-indigo-500/70 focus-ring"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-github-runtime-${scope}`}>
                  {t("model_rule_skill_runtime")}
                </label>
                <select
                  id={`model-rule-github-runtime-${scope}`}
                  value={config.skill_runtime ?? "openai"}
                  onChange={(e) => updateRuleConfig(model, (current) => ({
                    ...current,
                    mode: "github_skill",
                    skill_runtime: e.target.value as ModelSkillRuntime,
                  }))}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500/70 focus-ring"
                >
                  {SKILL_RUNTIMES.map((runtime) => (
                    <option key={runtime} value={runtime}>{t(`model_rule_runtime_${runtime}`)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleImportGithubSkill(model)}
                disabled={importingSkillFor === model}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-200 transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              >
                {importingSkillFor === model ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {t("model_rule_import_github")}
              </button>
              {config.skill_content && (
                <span className="text-xs text-gray-500">
                  {t("model_rule_skill_loaded", {
                    name: config.skill_name || "SKILL.md",
                    count: config.skill_content.length,
                  })}
                </span>
              )}
            </div>
          </div>
        )}

        {config.mode === "uploaded_skill" && (
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
              <div>
                <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-upload-${scope}`}>
                  {t("model_rule_upload_label")}
                </label>
                <input
                  id={`model-rule-upload-${scope}`}
                  type="file"
                  accept=".md,.markdown,.txt,.json,.yaml,.yml"
                  onChange={(e) => void handleUploadSkill(model, e.target.files?.[0])}
                  className="block w-full rounded-lg border border-dashed border-gray-700 bg-gray-900/50 px-3 py-2 text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-xs file:text-white hover:border-gray-600 focus-ring"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-upload-runtime-${scope}`}>
                  {t("model_rule_skill_runtime")}
                </label>
                <select
                  id={`model-rule-upload-runtime-${scope}`}
                  value={config.skill_runtime ?? "openai"}
                  onChange={(e) => updateRuleConfig(model, (current) => ({
                    ...current,
                    mode: "uploaded_skill",
                    skill_runtime: e.target.value as ModelSkillRuntime,
                  }))}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500/70 focus-ring"
                >
                  {SKILL_RUNTIMES.map((runtime) => (
                    <option key={runtime} value={runtime}>{t(`model_rule_runtime_${runtime}`)}</option>
                  ))}
                </select>
              </div>
            </div>
            {config.skill_content ? (
              <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
                <Upload className="h-3.5 w-3.5" />
                {t("model_rule_skill_loaded", {
                  name: config.skill_name || "SKILL.md",
                  count: config.skill_content.length,
                })}
              </div>
            ) : (
              <p className="text-xs text-gray-500">{t("model_rule_upload_hint")}</p>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!settings || !options) {
    return <div className="p-6 text-sm text-gray-500">{t("common:loading")}</div>;
  }

  return (
    <div className="space-y-6 p-6">
      {/* Section heading */}
      <div>
        <h3 className="text-lg font-semibold text-gray-100">{t("model_selection")}</h3>
        <p className="mt-1 text-sm text-gray-500">{t("model_selection_desc")}</p>
      </div>

      {/* Video backend selector */}
      <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="mb-3 text-sm font-medium text-gray-100">{t("default_video_model")}</div>
        {videoBackends.length > 0 ? (
          <ProviderModelSelect
            value={currentVideo}
            options={videoBackends}
            providerNames={allProviderNames}
            onChange={(v) => setDraft((prev) => ({ ...prev, default_video_backend: v }))}
            allowDefault
            defaultLabel={t("auto_select")}
            defaultHint={t("auto")}
          />
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-sm text-gray-500">
            {t("no_video_providers_hint")}
          </div>
        )}

        {/* Audio toggle */}
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={currentAudio}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, video_generate_audio: e.target.checked }))
            }
            className="rounded border-gray-600 bg-gray-800"
          />
          {t("generate_audio")}
          <span className="text-xs text-gray-500">{t("audio_support_hint")}</span>
        </label>

        {renderInlineRuleControls(MEDIA_RULE_TARGETS.video, "default-video")}
      </div>

      {/* Image backend selector */}
      <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="mb-3 text-sm font-medium text-gray-100">{t("default_image_model")}</div>
        {imageBackends.length > 0 ? (
          <ProviderModelSelect
            value={currentImage}
            options={imageBackends}
            providerNames={allProviderNames}
            onChange={(v) => setDraft((prev) => ({ ...prev, default_image_backend: v }))}
            allowDefault
            defaultLabel={t("auto_select")}
            defaultHint={t("auto")}
          />
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-sm text-gray-500">
            {t("no_image_providers_hint")}
          </div>
        )}

        {renderInlineRuleControls(MEDIA_RULE_TARGETS.image, "default-image")}
      </div>

      {/* Text backend selectors */}
      <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="mb-3 text-sm font-medium text-gray-100">{t("text_models")}</div>
        <p className="mb-3 text-xs text-gray-500">{t("text_models_desc")}</p>

        {textBackends.length > 0 ? (
          <div className="space-y-3">
            {TEXT_MODEL_FIELDS.map(([key, label]) => (
              <div key={key}>
                <div className="mb-1 text-xs text-gray-400">{label}</div>
                <ProviderModelSelect
                  value={(draft[key] ?? settings[key] ?? "")}
                  options={textBackends}
                  providerNames={allProviderNames}
                  onChange={(v) => setDraft((prev) => ({ ...prev, [key]: v }))}
                  allowDefault
                  defaultHint={t("auto")}
                  aria-label={label}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-sm text-gray-500">
            {t("no_text_providers_hint")}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-indigo-500/10 p-2 text-indigo-300">
            <FileText className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-100">{t("model_rules_title")}</div>
            <p className="mt-1 text-xs leading-5 text-gray-500">{t("model_rules_desc")}</p>
          </div>
        </div>

        {allRuleModels.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-800 px-3 py-4 text-sm text-gray-500">
            {t("model_rules_empty")}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs text-gray-400">{t("model_rule_pick_model")}</label>
              <ProviderModelSelect
                value={ruleModel}
                options={allRuleModels}
                providerNames={{
                  ...allProviderNames,
                  [MEDIA_RULE_PROVIDER_ID]: t("model_rule_target_media_group"),
                }}
                optionLabels={mediaRuleOptionLabels}
                onChange={setRuleModel}
                aria-label={t("model_rule_pick_model")}
              />
            </div>

            {[ruleModel].filter(Boolean).map((model) => {
              const config = normalizeRuleConfig(ruleConfigs[model]);
              const modelLabel = formatRuleTargetLabel(model);
              return (
                <div key={model} className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-gray-100">{modelLabel}</div>
                      {!isMediaRuleTarget(model) && (
                        <div className="mt-0.5 font-mono text-[11px] text-gray-600">{model}</div>
                      )}
                    </div>
                    <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-xs text-indigo-200">
                      {t(`model_rule_mode_${config.mode}`)}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label={t("model_rule_source_aria", { model: modelLabel })}>
                    {RULE_MODES.map((mode) => (
                      <label
                        key={mode}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          config.mode === mode
                            ? "border-indigo-500/70 bg-indigo-500/15 text-indigo-100"
                            : "border-gray-800 bg-gray-900/40 text-gray-400 hover:border-gray-700 hover:text-gray-200"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`model-rule-${model}`}
                          checked={config.mode === mode}
                          onChange={() => updateRuleConfig(model, (current) => switchRuleMode(current, mode))}
                          className="h-3.5 w-3.5 border-gray-600 bg-gray-900 text-indigo-500"
                        />
                        {t(`model_rule_mode_${mode}`)}
                      </label>
                    ))}
                  </div>

                  {config.mode === "prompt" && (
                    <div className="mt-3">
                      <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-prompt-${model}`}>
                        {t("model_rule_prompt_label")}
                      </label>
                      <textarea
                        id={`model-rule-prompt-${model}`}
                        value={config.prompt ?? ""}
                        onChange={(e) => updateRuleConfig(model, (current) => ({
                          ...current,
                          mode: "prompt",
                          prompt: e.target.value,
                        }))}
                        placeholder={t("model_rule_prompt_placeholder")}
                        className="min-h-28 w-full resize-y rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-indigo-500/70 focus-ring"
                      />
                    </div>
                  )}

                  {config.mode === "github_skill" && (
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
                        <div>
                          <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-github-${model}`}>
                            {t("model_rule_github_url")}
                          </label>
                          <input
                            id={`model-rule-github-${model}`}
                            type="url"
                            value={config.skill_github_url ?? ""}
                            onChange={(e) => updateRuleConfig(model, (current) => ({
                              ...current,
                              mode: "github_skill",
                              skill_github_url: e.target.value,
                            }))}
                            placeholder="https://github.com/org/repo/blob/main/SKILL.md"
                            className="w-full rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-indigo-500/70 focus-ring"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-github-runtime-${model}`}>
                            {t("model_rule_skill_runtime")}
                          </label>
                          <select
                            id={`model-rule-github-runtime-${model}`}
                            value={config.skill_runtime ?? "openai"}
                            onChange={(e) => updateRuleConfig(model, (current) => ({
                              ...current,
                              mode: "github_skill",
                              skill_runtime: e.target.value as ModelSkillRuntime,
                            }))}
                            className="w-full rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500/70 focus-ring"
                          >
                            {SKILL_RUNTIMES.map((runtime) => (
                              <option key={runtime} value={runtime}>{t(`model_rule_runtime_${runtime}`)}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleImportGithubSkill(model)}
                          disabled={importingSkillFor === model}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-200 transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
                        >
                          {importingSkillFor === model ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                          {t("model_rule_import_github")}
                        </button>
                        {config.skill_content && (
                          <span className="text-xs text-gray-500">
                            {t("model_rule_skill_loaded", {
                              name: config.skill_name || "SKILL.md",
                              count: config.skill_content.length,
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {config.mode === "uploaded_skill" && (
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
                        <div>
                          <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-upload-${model}`}>
                            {t("model_rule_upload_label")}
                          </label>
                          <input
                            id={`model-rule-upload-${model}`}
                            type="file"
                            accept=".md,.markdown,.txt,.json,.yaml,.yml"
                            onChange={(e) => void handleUploadSkill(model, e.target.files?.[0])}
                            className="block w-full rounded-lg border border-dashed border-gray-700 bg-gray-900/50 px-3 py-2 text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-xs file:text-white hover:border-gray-600 focus-ring"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400" htmlFor={`model-rule-upload-runtime-${model}`}>
                            {t("model_rule_skill_runtime")}
                          </label>
                          <select
                            id={`model-rule-upload-runtime-${model}`}
                            value={config.skill_runtime ?? "openai"}
                            onChange={(e) => updateRuleConfig(model, (current) => ({
                              ...current,
                              mode: "uploaded_skill",
                              skill_runtime: e.target.value as ModelSkillRuntime,
                            }))}
                            className="w-full rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500/70 focus-ring"
                          >
                            {SKILL_RUNTIMES.map((runtime) => (
                              <option key={runtime} value={runtime}>{t(`model_rule_runtime_${runtime}`)}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      {config.skill_content ? (
                        <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
                          <Upload className="h-3.5 w-3.5" />
                          {t("model_rule_skill_loaded", {
                            name: config.skill_name || "SKILL.md",
                            count: config.skill_content.length,
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500">{t("model_rule_upload_hint")}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Save / reset buttons */}
      {isDirty && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
          >
            {saving ? t("common:saving") : t("common:save")}
          </button>
          <button
            type="button"
            onClick={() => setDraft({})}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-gray-800 focus-ring"
          >
            {t("common:reset")}
          </button>
        </div>
      )}
    </div>
  );
}
