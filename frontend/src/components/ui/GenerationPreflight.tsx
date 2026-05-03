import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { API, type GenerationPreflightCheck, type GenerationPreflightResponse, type GenerationPreflightTaskType } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { errMsg } from "@/utils/async";

export interface GenerationPreflightConfig {
  projectName?: string | null;
  taskType: GenerationPreflightTaskType;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
  count?: number;
  targetLabel?: string;
}

function formatCredits(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "-";
}

function toRouterLocation(route: string): string {
  return route.startsWith("/app/") ? `~${route}` : route;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isProjectRelativePath(path: string) {
  const value = path.trim();
  return Boolean(value) && !value.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function travelReferenceAssetName(path: string) {
  const lastPart = path.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  return lastPart.replace(/\.[a-z0-9]+$/i, "") || lastPart;
}

function getTravelSceneAssetActionPaths(check: GenerationPreflightCheck) {
  if (check.action_kind !== "apply_travel_scene_assets" || !isRecord(check.action_payload)) {
    return [];
  }
  return getStringList(check.action_payload.missing_reference_images).filter(isProjectRelativePath);
}

function getStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function getModelRulePayload(check: GenerationPreflightCheck) {
  if (check.action_kind !== "model_rule_summary" || !isRecord(check.action_payload)) {
    return null;
  }
  return {
    mediaType: getStringField(check.action_payload, "media_type"),
    mode: getStringField(check.action_payload, "mode"),
    modeLabel: getStringField(check.action_payload, "mode_label"),
    targetLabel: getStringField(check.action_payload, "target_label"),
    skillName: getStringField(check.action_payload, "skill_name"),
    billingMode: getStringField(check.action_payload, "billing_mode"),
  };
}

function modelRuleModeLabel(
  payload: NonNullable<ReturnType<typeof getModelRulePayload>>,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (["default", "prompt", "github_skill", "uploaded_skill"].includes(payload.mode)) {
    return t(`dashboard:model_rule_mode_${payload.mode}`);
  }
  return payload.modeLabel || t("dashboard:model_rule_mode_default");
}

function modelRuleBillingLabel(
  payload: NonNullable<ReturnType<typeof getModelRulePayload>>,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (payload.billingMode === "platform_credits") return t("dashboard:billing_mode_platform");
  if (payload.billingMode === "byok") return t("dashboard:billing_mode_byok");
  return t("dashboard:task_model_rule_unknown_billing");
}

function modelRuleDetailItems(
  payload: NonNullable<ReturnType<typeof getModelRulePayload>>,
  t: ReturnType<typeof useTranslation>["t"],
) {
  return [
    {
      label: t("dashboard:task_model_rule_detail_mode"),
      value: modelRuleModeLabel(payload, t),
    },
    {
      label: t("dashboard:task_model_rule_detail_target"),
      value: payload.targetLabel || "-",
    },
    {
      label: t("dashboard:task_model_rule_detail_skill"),
      value: payload.skillName || t("dashboard:task_model_rule_no_skill"),
    },
    {
      label: t("dashboard:task_model_rule_detail_billing"),
      value: modelRuleBillingLabel(payload, t),
    },
  ];
}

async function refreshCurrentProjectIfOpen(projectName: string) {
  const projectState = useProjectsStore.getState();
  if (projectState.currentProjectName !== projectName) {
    return;
  }
  const refreshed = await API.getProject(projectName);
  useProjectsStore.getState().setCurrentProject(
    projectName,
    refreshed.project,
    refreshed.scripts ?? {},
    refreshed.asset_fingerprints,
  );
}

export function GenerationPreflightDialog({
  result,
  targetLabel,
  onCancel,
  onConfirm,
  onActionRoute,
  onActionComplete,
}: {
  result: GenerationPreflightResponse;
  targetLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onActionRoute: (route: string) => void;
  onActionComplete: () => Promise<GenerationPreflightResponse | void>;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const isPlatformCredits = result.billing_mode === "platform_credits";
  const [runningActionCode, setRunningActionCode] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);

  const handleApplyTravelSceneAssets = async (item: GenerationPreflightCheck) => {
    const paths = getTravelSceneAssetActionPaths(item);
    if (paths.length === 0) {
      if (item.action_route) {
        onActionRoute(item.action_route);
      }
      return;
    }

    const actionCode = `${item.code}-${item.action_kind ?? ""}`;
    setActionSuccessMessage(null);
    setRunningActionCode(actionCode);
    try {
      const assetResults = await Promise.allSettled(
        paths.map((path) =>
          API.addAssetFromProjectFile({
            project_name: result.project_name,
            file_path: path,
            asset_type: "scene",
            name: travelReferenceAssetName(path),
            description: t("dashboard:travel_route_asset_library_description", { path }),
            conflict_policy: "rename",
          }),
        ),
      );
      const savedAssets = assetResults.flatMap((entry) =>
        entry.status === "fulfilled" ? [entry.value.asset] : [],
      );
      let failures = assetResults.length - savedAssets.length;
      let appliedCount = 0;

      if (savedAssets.length > 0) {
        const applyResult = await API.applyAssetsToProject({
          asset_ids: savedAssets.map((asset) => asset.id),
          target_project: result.project_name,
          conflict_policy: "skip",
        });
        appliedCount = applyResult.succeeded.length + applyResult.skipped.length;
        failures += applyResult.failed.length;
      }

      try {
        await refreshCurrentProjectIfOpen(result.project_name);
      } catch {
        // The preflight refresh below is enough for correctness; the open project can refresh later.
      }

      if (appliedCount > 0) {
        useAppStore.getState().pushToast(
          t("dashboard:generation_preflight_scene_assets_apply_done", { count: appliedCount }),
          failures > 0 ? "warning" : "success",
        );
      }
      if (failures > 0) {
        useAppStore.getState().pushNotification(
          t("dashboard:generation_preflight_scene_assets_apply_failed", { count: failures }),
          "error",
        );
      }
      const refreshedPreflight = await onActionComplete();
      if (appliedCount > 0 && failures === 0 && (refreshedPreflight?.can_submit ?? result.can_submit)) {
        setActionSuccessMessage(t("dashboard:generation_preflight_fix_success"));
      }
    } catch (err) {
      useAppStore.getState().pushNotification(
        t("dashboard:generation_preflight_scene_assets_apply_error", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setRunningActionCode(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 py-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-preflight-title"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 shadow-2xl shadow-black/40"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 p-6 pb-4">
          <div>
            <h2 id="generation-preflight-title" className="text-lg font-semibold text-gray-100">
              {t("dashboard:generation_preflight_title")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">
              {isPlatformCredits
                ? t("dashboard:generation_preflight_platform_desc")
                : t("dashboard:generation_preflight_byok_desc")}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
          >
            {t("common:close")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-black/20 px-3 py-2">
              <p className="text-xs text-gray-500">{t("dashboard:generation_preflight_task")}</p>
              <p className="mt-1 truncate text-sm font-medium text-gray-100">
                {targetLabel || result.resource_id || result.task_type}
              </p>
            </div>
            <div className="rounded-lg bg-black/20 px-3 py-2">
              <p className="text-xs text-gray-500">{t("dashboard:generation_preflight_billing")}</p>
              <p className="mt-1 text-sm font-medium text-gray-100">
                {isPlatformCredits
                  ? t("dashboard:generation_preflight_billing_platform")
                  : t("dashboard:generation_preflight_billing_byok")}
              </p>
            </div>
            <div className="rounded-lg bg-black/20 px-3 py-2">
              <p className="text-xs text-gray-500">{t("dashboard:generation_preflight_required")}</p>
              <p className="mt-1 font-mono text-sm text-gray-100">
                {isPlatformCredits
                  ? t("dashboard:generation_preflight_credit_count", {
                    count: formatCredits(result.required_credits),
                  })
                  : t("dashboard:generation_preflight_no_platform_charge")}
              </p>
            </div>
            <div className="rounded-lg bg-black/20 px-3 py-2">
              <p className="text-xs text-gray-500">{t("dashboard:generation_preflight_available")}</p>
              <p className="mt-1 font-mono text-sm text-gray-100">
                {isPlatformCredits
                  ? t("dashboard:generation_preflight_credit_count", {
                    count: formatCredits(result.available_balance),
                  })
                  : "-"}
              </p>
            </div>
          </div>

          {result.checks && result.checks.length > 0 && (
            <div className="mt-4 rounded-xl border border-gray-800 bg-black/15 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                {t("dashboard:generation_preflight_checks")}
              </p>
              <div className="mt-2 space-y-2">
                {result.checks.map((item) => {
                const modelRulePayload = getModelRulePayload(item);
                const modelRuleDetails = modelRulePayload ? modelRuleDetailItems(modelRulePayload, t) : [];
                return (
                  <div
                    key={`${item.code}-${item.message}`}
                    className={`rounded-lg border px-3 py-2 ${
                      item.status === "ok"
                        ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                        : item.status === "warning"
                          ? "border-amber-400/20 bg-amber-500/10 text-amber-100"
                          : "border-red-400/20 bg-red-500/10 text-red-100"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{item.label}</p>
                      <span className="shrink-0 rounded-md bg-black/20 px-1.5 py-0.5 text-[11px] uppercase tracking-wide opacity-80">
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-6 opacity-90">{item.message}</p>
                    {modelRulePayload && (
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-current/15 bg-black/15 px-2 py-1.5 text-[11px] sm:grid-cols-4">
                        {modelRuleDetails.map((detail) => (
                          <div key={detail.label} className="min-w-0">
                            <dt className="opacity-60">{detail.label}</dt>
                            <dd className="truncate font-medium" title={detail.value}>
                              {detail.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {item.action_label && item.action_kind === "apply_travel_scene_assets" && (
                      <button
                        type="button"
                        onClick={() => void handleApplyTravelSceneAssets(item)}
                        disabled={runningActionCode === `${item.code}-${item.action_kind ?? ""}`}
                        className="mt-2 inline-flex items-center rounded-md border border-current/20 bg-black/15 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/25 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {runningActionCode === `${item.code}-${item.action_kind ?? ""}`
                          ? t("dashboard:generation_preflight_scene_assets_applying")
                          : item.action_label}
                      </button>
                    )}
                    {item.action_label && item.action_kind !== "apply_travel_scene_assets" && item.action_route && (
                      <button
                        type="button"
                        onClick={() => onActionRoute(item.action_route || "")}
                        className="mt-2 inline-flex items-center rounded-md border border-current/20 bg-black/15 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/25"
                      >
                        {item.action_label}
                      </button>
                    )}
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {actionSuccessMessage && (
            <div className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-sm leading-6 text-emerald-100">
              {actionSuccessMessage}
            </div>
          )}

          {(result.blocking.length > 0 || result.warnings.length > 0) && (
            <div className="mt-4 space-y-2">
              {result.blocking.map((item) => (
                <p
                  key={`${item.code}-${item.message}`}
                  className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm leading-6 text-red-100"
                >
                  {item.message}
                </p>
              ))}
              {result.warnings.map((item) => (
                <p
                  key={`${item.code}-${item.message}`}
                  className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-100"
                >
                  {item.message}
                </p>
              ))}
            </div>
          )}

          {isPlatformCredits && (
            <p className="mt-4 text-xs leading-5 text-gray-500">
              {t("dashboard:generation_preflight_reserve_note", {
                reserved: formatCredits(result.reserved_generation_credits),
              })}
            </p>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-800 bg-gray-900/95 px-6 py-4">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-700 px-4 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
            >
              {t("common:cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!result.can_submit}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {result.can_submit
                ? t("dashboard:generation_preflight_confirm")
                : t("dashboard:generation_preflight_blocked")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function useGenerationPreflightGate() {
  const { t } = useTranslation("dashboard");
  const [, navigate] = useLocation();
  const [checkingGenerationPreflight, setCheckingGenerationPreflight] = useState(false);
  const [pending, setPending] = useState<{
    result: GenerationPreflightResponse;
    targetLabel?: string;
    onConfirm: () => void | Promise<void>;
    config: GenerationPreflightConfig;
  } | null>(null);

  const runWithGenerationPreflight = useCallback(
    async (config: GenerationPreflightConfig | undefined, onConfirm: () => void | Promise<void>) => {
      if (!config?.projectName) {
        await onConfirm();
        return;
      }

      setCheckingGenerationPreflight(true);
      try {
        const result = await API.requestGenerationPreflight(config.projectName, {
          task_type: config.taskType,
          payload: config.payload ?? {},
          resource_id: config.resourceId ?? undefined,
          count: config.count ?? 1,
        });
        setPending({
          result,
          targetLabel: config.targetLabel,
          onConfirm,
          config,
        });
      } catch (err) {
        useAppStore.getState().pushToast(
          t("generation_preflight_failed", { message: errMsg(err) }),
          "warning",
        );
        await onConfirm();
      } finally {
        setCheckingGenerationPreflight(false);
      }
    },
    [t],
  );

  const generationPreflightDialog = pending ? (
    <GenerationPreflightDialog
      result={pending.result}
      targetLabel={pending.targetLabel}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const action = pending.onConfirm;
        setPending(null);
        void action();
      }}
      onActionRoute={(route) => {
        setPending(null);
        navigate(toRouterLocation(route));
      }}
      onActionComplete={async () => {
        const current = pending;
        if (!current?.config.projectName) {
          return;
        }
        const result = await API.requestGenerationPreflight(current.config.projectName, {
          task_type: current.config.taskType,
          payload: current.config.payload ?? {},
          resource_id: current.config.resourceId ?? undefined,
          count: current.config.count ?? 1,
        });
        setPending({ ...current, result });
        return result;
      }}
    />
  ) : null;

  return {
    checkingGenerationPreflight,
    generationPreflightDialog,
    runWithGenerationPreflight,
  };
}
