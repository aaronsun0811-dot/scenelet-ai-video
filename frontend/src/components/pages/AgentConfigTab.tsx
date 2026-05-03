
import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg, voidCall } from "@/utils/async";
import { Bot, ChevronDown, Eye, EyeOff, Loader2, SlidersHorizontal, Terminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWarnUnsaved } from "@/hooks/useWarnUnsaved";
import { API } from "@/api";
import { ProviderModelSelect } from "@/components/ui/ProviderModelSelect";
import { ProviderIcon, PROVIDER_NAMES } from "@/components/ui/ProviderIcon";
import { useAppStore } from "@/stores/app-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import type { GetSystemConfigResponse, SystemConfigPatch } from "@/types";
import { TabSaveFooter } from "./TabSaveFooter";

// ---------------------------------------------------------------------------
// Draft types
// ---------------------------------------------------------------------------

interface AgentDraft {
  anthropicKey: string;        // new API key input (empty = don't change)
  anthropicBaseUrl: string;    // in-place editing; empty = clear
  agentModelBackend: string;   // provider/model selection for Scenelet agent
  anthropicModel: string;      // in-place editing; empty = clear
  haikuModel: string;
  opusModel: string;
  sonnetModel: string;
  subagentModel: string;
  cleanupDelaySeconds: string;
  maxConcurrentSessions: string;
}

function buildDraft(data: GetSystemConfigResponse): AgentDraft {
  const s = data.settings;
  return {
    anthropicKey: "",
    anthropicBaseUrl: s.anthropic_base_url ?? "",
    agentModelBackend: s.agent_model_backend ?? "",
    anthropicModel: s.anthropic_model ?? "",
    haikuModel: s.anthropic_default_haiku_model ?? "",
    opusModel: s.anthropic_default_opus_model ?? "",
    sonnetModel: s.anthropic_default_sonnet_model ?? "",
    subagentModel: s.claude_code_subagent_model ?? "",
    cleanupDelaySeconds: String(s.agent_session_cleanup_delay_seconds ?? 300),
    maxConcurrentSessions: String(s.agent_max_concurrent_sessions ?? 5),
  };
}

function deepEqual(a: AgentDraft, b: AgentDraft): boolean {
  return (
    a.anthropicKey === b.anthropicKey &&
    a.anthropicBaseUrl === b.anthropicBaseUrl &&
    a.agentModelBackend === b.agentModelBackend &&
    a.anthropicModel === b.anthropicModel &&
    a.haikuModel === b.haikuModel &&
    a.opusModel === b.opusModel &&
    a.sonnetModel === b.sonnetModel &&
    a.subagentModel === b.subagentModel &&
    a.cleanupDelaySeconds === b.cleanupDelaySeconds &&
    a.maxConcurrentSessions === b.maxConcurrentSessions
  );
}

function buildPatch(draft: AgentDraft, saved: AgentDraft): SystemConfigPatch {
  const patch: SystemConfigPatch = {};
  if (draft.anthropicKey.trim()) patch.anthropic_api_key = draft.anthropicKey.trim();
  if (draft.anthropicBaseUrl !== saved.anthropicBaseUrl)
    patch.anthropic_base_url = draft.anthropicBaseUrl || "";
  if (draft.agentModelBackend !== saved.agentModelBackend)
    patch.agent_model_backend = draft.agentModelBackend || "";
  if (draft.anthropicModel !== saved.anthropicModel)
    patch.anthropic_model = draft.anthropicModel || "";
  if (draft.haikuModel !== saved.haikuModel)
    patch.anthropic_default_haiku_model = draft.haikuModel || "";
  if (draft.opusModel !== saved.opusModel)
    patch.anthropic_default_opus_model = draft.opusModel || "";
  if (draft.sonnetModel !== saved.sonnetModel)
    patch.anthropic_default_sonnet_model = draft.sonnetModel || "";
  if (draft.subagentModel !== saved.subagentModel)
    patch.claude_code_subagent_model = draft.subagentModel || "";
  if (draft.cleanupDelaySeconds !== saved.cleanupDelaySeconds)
    patch.agent_session_cleanup_delay_seconds = Number(draft.cleanupDelaySeconds) || 300;
  if (draft.maxConcurrentSessions !== saved.maxConcurrentSessions)
    patch.agent_max_concurrent_sessions = Number(draft.maxConcurrentSessions) || 5;
  return patch;
}

// ---------------------------------------------------------------------------
// Shared style constants
// ---------------------------------------------------------------------------

const cardClassName = "rounded-xl border border-gray-800 bg-gray-950/40 p-4";
const inputClassName =
  "w-full rounded-lg border border-gray-700 bg-gray-900/80 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500/60";
const smallBtnClassName =
  "rounded p-1 text-gray-500 hover:text-gray-300 focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:outline-none";

// Model routing config — static, hoisted to module level to avoid re-creation on each render
const MODEL_ROUTING_FIELDS = [
  {
    key: "haikuModel" as const,
    labelKey: "haiku_model",
    envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    hintKey: "haiku_desc",
    patchKey: "anthropic_default_haiku_model" as const,
  },
  {
    key: "sonnetModel" as const,
    labelKey: "sonnet_model",
    envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    hintKey: "sonnet_desc",
    patchKey: "anthropic_default_sonnet_model" as const,
  },
  {
    key: "opusModel" as const,
    labelKey: "opus_model",
    envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    hintKey: "opus_desc",
    patchKey: "anthropic_default_opus_model" as const,
  },
  {
    key: "subagentModel" as const,
    labelKey: "subagent_model",
    envVar: "CLAUDE_CODE_SUBAGENT_MODEL",
    hintKey: "subagent_desc",
    patchKey: "claude_code_subagent_model" as const,
  },
] as const;

// Small inline clear button shown next to "当前：" when a value is set
const inlineClearClassName =
  "ml-1.5 inline-flex items-center rounded p-0.5 text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50";

const BUILTIN_AGENT_BACKENDS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-sonnet-4-5-20250929",
  "anthropic/claude-opus-4-1-20250805",
  "anthropic/claude-opus-4-6",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "gemini-aistudio/gemini-3.1-pro-preview",
  "gemini-aistudio/gemini-3-flash-preview",
  "gemini-aistudio/gemini-3.1-flash-lite-preview",
  "gemini-vertex/gemini-3.1-pro-preview",
  "gemini-vertex/gemini-3-flash-preview",
  "ark/doubao-seed-2-0-pro-260215",
  "ark/doubao-seed-2-0-lite-260215",
  "baidu/ernie-4.5-turbo-128k",
  "qwen/qwen-plus",
  "qwen/qwen-max",
  "zhipu/glm-4.5",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "moonshot/kimi-latest",
  "moonshot/kimi-k2",
  "minimax/minimax-text-01",
  "hunyuan/hunyuan-turbo",
] as const;
const AGENT_PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "gemini-aistudio",
  "gemini-vertex",
  "ark",
  "deepseek",
  "qwen",
  "moonshot",
  "zhipu",
  "baidu",
  "minimax",
  "hunyuan",
] as const;

function modelIdFromBackend(value: string): string {
  const slashIndex = value.indexOf("/");
  return slashIndex === -1 ? value.trim() : value.slice(slashIndex + 1).trim();
}

function providerIdFromBackend(value: string): string {
  const slashIndex = value.indexOf("/");
  return slashIndex === -1 ? value.trim() : value.slice(0, slashIndex).trim();
}

function sortAgentBackends(options: string[]): string[] {
  const providerRank = new Map<string, number>(AGENT_PROVIDER_ORDER.map((provider, index) => [provider, index]));
  return [...options].sort((a, b) => {
    const providerA = a.split("/", 1)[0];
    const providerB = b.split("/", 1)[0];
    const rankA = providerRank.get(providerA) ?? 999;
    const rankB = providerRank.get(providerB) ?? 999;
    if (rankA !== rankB) return rankA - rankB;
    return a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold text-gray-100">{title}</h3>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentConfigTabProps {
  visible: boolean;
}

export function AgentConfigTab({ visible }: AgentConfigTabProps) {
  const { t } = useTranslation("dashboard");
  const [remoteData, setRemoteData] = useState<GetSystemConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft>({
    anthropicKey: "",
    anthropicBaseUrl: "",
    agentModelBackend: "",
    anthropicModel: "",
    haikuModel: "",
    opusModel: "",
    sonnetModel: "",
    subagentModel: "",
    cleanupDelaySeconds: "300",
    maxConcurrentSessions: "5",
  });
  const savedRef = useRef<AgentDraft>({
    anthropicKey: "",
    anthropicBaseUrl: "",
    agentModelBackend: "",
    anthropicModel: "",
    haikuModel: "",
    opusModel: "",
    sonnetModel: "",
    subagentModel: "",
    cleanupDelaySeconds: "300",
    maxConcurrentSessions: "5",
  });
  const [saving, setSaving] = useState(false);
  const [clearingField, setClearingField] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [modelRoutingExpanded, setModelRoutingExpanded] = useState(false);

  // Load config on mount
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await API.getSystemConfig();
      setRemoteData(res);
      const d = buildDraft(res);
      savedRef.current = d;
      setDraft(d);
    } catch (err) {
      setLoadError(errMsg(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const isDirty = !deepEqual(draft, savedRef.current);
  useWarnUnsaved(isDirty);

  const updateDraft = useCallback(
    <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
      setSaveError(null);
    },
    [],
  );

  const handleAgentBackendChange = useCallback((value: string) => {
    const modelId = modelIdFromBackend(value);
    setDraft((prev) => ({
      ...prev,
      agentModelBackend: value,
      anthropicModel: modelId,
    }));
    setSaveError(null);
  }, []);

  const handleManualModelChange = useCallback((value: string) => {
    setDraft((prev) => ({
      ...prev,
      agentModelBackend: "",
      anthropicModel: value,
    }));
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    const patch = buildPatch(draft, savedRef.current);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await API.updateSystemConfig(patch);
      setRemoteData(res);
      const newDraft = buildDraft(res);
      savedRef.current = newDraft;
      setDraft(newDraft);
      voidCall(useConfigStatusStore.getState().refresh());
      useAppStore.getState().pushToast(t("agent_config_saved"), "success");
    } catch (err) {
      setSaveError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }, [draft, t]);

  const handleReset = useCallback(() => {
    setDraft(savedRef.current);
    setSaveError(null);
  }, []);

  // Clear a single field immediately via PATCH
  const handleClearField = useCallback(
    async (fieldId: string, patch: SystemConfigPatch, label: string) => {
      setClearingField(fieldId);
      try {
        const res = await API.updateSystemConfig(patch);
        setRemoteData(res);
        const nextSavedDraft = buildDraft(res);
        savedRef.current = nextSavedDraft;
        setDraft(nextSavedDraft);
        voidCall(useConfigStatusStore.getState().refresh());
        useAppStore.getState().pushToast(`${t(`dashboard:${label}`)} ${t("field_cleared")}`, "success");
      } catch (err) {
        useAppStore.getState().pushToast(t("clear_failed", { message: errMsg(err) }), "error");
      } finally {
        setClearingField(null);
      }
    },
    [t],
  );

  const isBusy = saving || clearingField !== null;

  // Loading / error states
  if (loadError) {
    return (
      <div className={visible ? "px-6 py-8" : "hidden"}>
        <div className="text-sm text-rose-400">{t("load_failed", { message: loadError })}</div>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-gray-600 hover:bg-gray-800/50"
        >
          <Loader2 className="h-4 w-4" />
          {t("common:retry")}
        </button>
      </div>
    );
  }

  if (!remoteData) {
    return (
      <div className={visible ? "flex items-center gap-2 px-6 py-8 text-gray-400" : "hidden"}>
        <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
        {t("common:loading")}
      </div>
    );
  }

  const settings = remoteData.settings;
  const allProviderNames = { ...PROVIDER_NAMES, ...(remoteData.options.provider_names ?? {}) };
  const remoteAgentBackends = remoteData.options.agent_backends ?? remoteData.options.text_backends ?? [];
  const agentBackends = sortAgentBackends(
    Array.from(new Set([...BUILTIN_AGENT_BACKENDS, ...remoteAgentBackends])),
  );
  const selectedAgentBackend = draft.agentModelBackend || settings.agent_model_backend || "";
  const selectedProviderId = providerIdFromBackend(selectedAgentBackend);
  const selectedProviderName = selectedProviderId
    ? allProviderNames[selectedProviderId] || selectedProviderId
    : t("agent_model_follow_default");
  const isAnthropicAgentSelected = !selectedProviderId || selectedProviderId === "anthropic";

  return (
    <div className={visible ? undefined : "hidden"}>
      <div className="space-y-8 px-6 pb-0 pt-6">
        {/* Page intro */}
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-3 shadow-inner shadow-white/5">
              <Bot className="h-6 w-6 text-indigo-200" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-100">{t("arcreel_agent")}</h2>
              <p className="text-sm text-gray-500">
                {t("agent_sdk_desc")}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-gray-800/60 bg-gray-900/30 px-3 py-2">
            <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500" />
            <p className="text-xs text-gray-500">
              {t("claude_code_compat_hint")}
            </p>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Section 1: Provider / Model */}
        {/* ----------------------------------------------------------------- */}
        <div>
          <SectionHeading
            title={t("model_config")}
            description={t("model_config_desc")}
          />

          <div className={cardClassName}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-100">
                {t("agent_model_backend")}
              </label>
              {(settings.agent_model_backend || settings.anthropic_model) && (
                <button
                  type="button"
                  onClick={() =>
                    void handleClearField(
                      "anthropic_model",
                      { agent_model_backend: "", anthropic_model: "" },
                      "agent_model_backend",
                    )
                  }
                  disabled={isBusy}
                  className="inline-flex items-center gap-1 rounded text-xs text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
                  aria-label={t("clear_saved_model")}
                >
                  {clearingField === "anthropic_model" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                  {t("clear_saved")}
                </button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              {t("agent_model_backend_desc")}
            </p>
            <div className="mt-2">
              <ProviderModelSelect
                value={draft.agentModelBackend}
                options={agentBackends}
                providerNames={allProviderNames}
                onChange={handleAgentBackendChange}
                allowDefault
                defaultLabel={t("agent_model_follow_default")}
                defaultHint={t("agent_model_follow_default_hint")}
                aria-label={t("agent_model_backend")}
              />
            </div>
            <p className="mt-3 text-xs text-gray-500">
              {t("agent_model_gateway_hint")}
            </p>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Section 2: API Key + Base URL */}
        {/* ----------------------------------------------------------------- */}
        <div>
          <SectionHeading
            title={t("api_credentials")}
            description={
              isAnthropicAgentSelected
                ? t("anthropic_key_required_desc")
                : t("agent_gateway_required_desc", { provider: selectedProviderName })
            }
          />

          {/* API Key card */}
          <div className={`${cardClassName} space-y-4`}>
            <div className="flex items-center gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-100">
              {selectedProviderId ? (
                <ProviderIcon providerId={selectedProviderId} className="h-4 w-4 shrink-0" />
              ) : (
                <Bot className="h-4 w-4 shrink-0" />
              )}
              <span>
                {t("agent_selected_provider_hint", { provider: selectedProviderName })}
              </span>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="agent-anthropic-key" className="text-sm font-medium text-gray-100">
                  {isAnthropicAgentSelected ? t("anthropic_api_key") : t("agent_gateway_api_key")}
                </label>
                {settings.anthropic_api_key.is_set && (
                  <div className="flex items-center text-xs text-gray-500">
                    <span className="truncate">
                      {t("current_label")}{settings.anthropic_api_key.masked ?? t("encrypted")}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void handleClearField(
                          "anthropic_api_key",
                          { anthropic_api_key: "" },
                          "anthropic_api_key",
                        )
                      }
                      disabled={isBusy}
                      className={inlineClearClassName}
                      aria-label={t("clear_saved_anthropic_key")}
                    >
                      {clearingField === "anthropic_api_key" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-500">
                {isAnthropicAgentSelected
                  ? t("env_anthropic_api_key")
                  : t("agent_gateway_key_hint", { provider: selectedProviderName })}
              </p>
              <div className="relative mt-2">
                <input
                  id="agent-anthropic-key"
                  type={showKey ? "text" : "password"}
                  value={draft.anthropicKey}
                  onChange={(e) => updateDraft("anthropicKey", e.target.value)}
                  placeholder={isAnthropicAgentSelected ? "sk-ant-…" : t("agent_gateway_key_placeholder")}
                  className={`${inputClassName} pr-10`}
                  autoComplete="off"
                  spellCheck={false}
                  name="anthropic_api_key"
                  disabled={saving}
                />
                {draft.anthropicKey && (
                  <button
                    type="button"
                    onClick={() => updateDraft("anthropicKey", "")}
                    className={`absolute right-8 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                    aria-label={t("clear_input")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                  aria-label={showKey ? t("hide_key") : t("show_key")}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Base URL */}
            <div className="border-t border-gray-800 pt-4">
              <div className="flex items-center justify-between">
                <label htmlFor="agent-base-url" className="text-sm font-medium text-gray-100">
                  {t("api_base_url")}
                </label>
                {settings.anthropic_base_url && (
                  <button
                    type="button"
                    onClick={() =>
                      void handleClearField(
                        "anthropic_base_url",
                        { anthropic_base_url: "" },
                        "api_base_url",
                      )
                    }
                    disabled={isBusy}
                    className="inline-flex items-center gap-1 rounded text-xs text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
                    aria-label={t("clear_saved_base_url")}
                  >
                    {clearingField === "anthropic_base_url" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                    {t("clear_saved")}
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-500">
                {isAnthropicAgentSelected ? t("env_anthropic_base_url") : t("agent_gateway_base_url_hint")}
              </p>
              <div className="relative mt-2">
                <input
                  id="agent-base-url"
                  value={draft.anthropicBaseUrl}
                  onChange={(e) => updateDraft("anthropicBaseUrl", e.target.value)}
                  placeholder={isAnthropicAgentSelected ? t("api_base_example") : "https://your-claude-compatible-gateway.example.com"}
                  className={`${inputClassName}${draft.anthropicBaseUrl ? " pr-8" : ""}`}
                  autoComplete="off"
                  spellCheck={false}
                  name="anthropic_base_url"
                  disabled={saving}
                />
                {draft.anthropicBaseUrl && (
                  <button
                    type="button"
                    onClick={() => updateDraft("anthropicBaseUrl", "")}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                    aria-label={t("clear_base_url_input")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Section 3: Default Model / Routing */}
        {/* ----------------------------------------------------------------- */}
        <div>
          <SectionHeading
            title={t("agent_default_model_routing")}
            description={t("agent_default_model_routing_desc")}
          />

          <div className={cardClassName}>
            <div>
              <label htmlFor="agent-model" className="text-sm font-medium text-gray-100">
                {t("default_model")}
              </label>
              <p className="mt-0.5 text-xs text-gray-500">
                {t("env_anthropic_model")}
              </p>
            </div>
            <div className="relative mt-2">
              <input
                id="agent-model"
                value={draft.anthropicModel}
                onChange={(e) => handleManualModelChange(e.target.value)}
                placeholder="claude-3-5-sonnet-20241022"
                className={`${inputClassName}${draft.anthropicModel ? " pr-8" : ""}`}
                autoComplete="off"
                spellCheck={false}
                name="anthropic_model"
                disabled={saving}
              />
              {draft.anthropicModel && (
                <button
                  type="button"
                  onClick={() => handleManualModelChange("")}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                  aria-label={t("clear_model_input")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Advanced model routing */}
            <details
              open={modelRoutingExpanded}
              onToggle={(e) => setModelRoutingExpanded(e.currentTarget.open)}
              className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40 p-4"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-gray-100">
                <span className="inline-flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-gray-400" />
                  {t("advanced_model_routing")}
                </span>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-800 bg-gray-900 text-gray-500">
                  <ChevronDown
                    className={`h-4 w-4 transition-transform duration-200 ${
                      modelRoutingExpanded ? "rotate-180 text-gray-200" : ""
                    }`}
                  />
                </span>
              </summary>
              <p className="mt-2 text-xs text-gray-500">
                {t("model_routing_hint")}
              </p>
              <div className="mt-4 grid gap-4">
                {MODEL_ROUTING_FIELDS.map(({ key, labelKey, envVar, hintKey, patchKey }) => {
                  const settingsValue = settings[patchKey];
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-gray-100">{t(`dashboard:${labelKey}`)}</div>
                          <div className="text-xs text-gray-500">{t(`dashboard:${hintKey}`)}</div>
                        </div>
                        {settingsValue && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleClearField(
                                patchKey,
                                { [patchKey]: "" } as SystemConfigPatch,
                                labelKey,
                              )
                            }
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 text-xs text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50 focus-ring rounded"
                            aria-label={t("clear_saved_field", { label: t(`dashboard:${labelKey}`) })}
                          >
                            {clearingField === patchKey ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <X className="h-3 w-3" />
                            )}
                            {t("clear")}
                          </button>
                        )}
                      </div>
                      <div className="relative mt-1.5">
                        <input
                          value={draft[key]}
                          onChange={(e) => updateDraft(key, e.target.value)}
                          placeholder={envVar}
                          className={`${inputClassName}${draft[key] ? " pr-8" : ""}`}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={saving}
                        />
                        {draft[key] && (
                          <button
                            type="button"
                            onClick={() => updateDraft(key, "")}
                            className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                            aria-label={t("clear_field_input", { label: t(`dashboard:${labelKey}`) })}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          </div>
        </div>

        {/* 高级设置 */}
        <div className={cardClassName}>
          <details>
            <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-gray-400 transition-colors hover:text-gray-200">
              <SlidersHorizontal className="h-4 w-4" />
              {t("advanced_settings")}
            </summary>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-200">
                  {t("session_cleanup_delay_label")}
                </label>
                <p className="mt-0.5 text-xs text-gray-500">
                  {t("session_cleanup_delay_desc")}
                </p>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  value={draft.cleanupDelaySeconds}
                  onChange={(e) => updateDraft("cleanupDelaySeconds", e.target.value)}
                  className={`${inputClassName} mt-1.5 max-w-[120px]`}
                  disabled={saving}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-200">
                  {t("max_concurrent_sessions_label")}
                </label>
                <p className="mt-0.5 text-xs text-gray-500">
                  {t("max_concurrent_sessions_desc")}
                </p>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.maxConcurrentSessions}
                  onChange={(e) => updateDraft("maxConcurrentSessions", e.target.value)}
                  className={`${inputClassName} mt-1.5 max-w-[120px]`}
                  disabled={saving}
                />
              </div>
            </div>
          </details>
        </div>
      </div>

      <TabSaveFooter
        isDirty={isDirty}
        saving={saving}
        disabled={clearingField !== null}
        error={saveError}
        onSave={() => void handleSave()}
        onReset={handleReset}
      />
    </div>
  );
}
