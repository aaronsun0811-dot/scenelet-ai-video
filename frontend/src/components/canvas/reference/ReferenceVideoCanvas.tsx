// frontend/src/components/canvas/reference/ReferenceVideoCanvas.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Clock3, Edit3, ImageIcon, Landmark, Loader2, MapPinned, Save, Sparkles, X as XIcon } from "lucide-react";
import { UnitList } from "./UnitList";
import { UnitPreviewPanel } from "./UnitPreviewPanel";
import { ReferenceVideoCard, unitPromptText } from "./ReferenceVideoCard";
import { ReferencePanel } from "./ReferencePanel";
import { useGenerationPreflightGate } from "@/components/ui/GenerationPreflight";
import { PreprocessingView } from "@/components/canvas/timeline/PreprocessingView";
import { useReferenceVideoStore, referenceVideoCacheKey } from "@/stores/reference-video-store";
import { useTasksStore } from "@/stores/tasks-store";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { API } from "@/api";
import { errMsg } from "@/utils/async";
import { mergeReferences } from "@/utils/reference-mentions";
import type { ProjectData, ReferenceResource, ReferenceVideoUnit, TaskStatus, TravelRoutePreviewNode, TravelVideoSettings, UnitStatus, WorkspaceFocusTarget } from "@/types";

export interface ReferenceVideoCanvasProps {
  projectName: string;
  episode: number;
  episodeTitle?: string;
}

const EMPTY_UNITS: readonly ReferenceVideoUnit[] = Object.freeze([]);

// 预处理状态小圆点颜色。纯静态映射提到模块顶层，避免每次 render 重建对象。
type PreprocStatus = "loading" | "error" | "empty" | "ready";
const PREPROC_DOT_CLASS: Record<PreprocStatus, string> = {
  loading: "bg-gray-500",
  error: "bg-red-500",
  empty: "bg-gray-500",
  ready: "bg-emerald-500",
};

// 视频 Tab 标签旁的状态小圆点配色——和 UnitList 的 STATUS_DOT 约定一致：
// 运行中的任务给一个显眼的暖色，完成为 emerald，失败红，未生成灰（等同 pending）。
const VIDEO_DOT_CLASS: Record<UnitStatus, string> = {
  pending: "bg-gray-500",
  running: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-500",
  failed: "bg-red-500",
};

/** 草稿 map 的复合键：`unit_id` 格式 `E{episode}U{n}` 在不同项目下会重复，所以必须
 *  把 project+episode 一同编入 key，否则切换项目会误把旧项目的未保存草稿应用到新项目
 *  同名 unit 上，造成跨项目数据污染。与 store 侧的 `_debounceKey` 约定一致。 */
function draftKey(projectName: string, episode: number, unitId: string): string {
  return `${projectName}::${episode}::${unitId}`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function travelReferenceImages(settings: TravelVideoSettings | null | undefined): string[] {
  return uniqueStrings([
    ...(settings?.reference_images ?? []),
    ...(settings?.route_preview?.reference_images ?? []),
  ]);
}

function isLocalTravelReferencePath(path: string) {
  const value = path.trim();
  return Boolean(value) && !value.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function travelReferenceAssetName(path: string) {
  const lastPart = path.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  return lastPart.replace(/\.[a-z0-9]+$/i, "") || lastPart;
}

function travelTargetSeconds(settings: TravelVideoSettings | null | undefined): number | null {
  const target = settings?.target_duration ?? "45s";
  if (target === "custom") {
    const custom = settings?.custom_duration_seconds;
    return typeof custom === "number" && Number.isFinite(custom) && custom > 0
      ? Math.round(custom)
      : null;
  }
  const parsed = Number.parseInt(target.replace("s", ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, "");
}

function matchTravelRouteNodes(unit: ReferenceVideoUnit, nodes: TravelRoutePreviewNode[]): TravelRoutePreviewNode[] {
  if (nodes.length === 0) return [];
  const promptText = normalizeMatchText(unitPromptText(unit));
  return nodes.filter((node) => {
    const label = normalizeMatchText(node.label);
    const instruction = normalizeMatchText(node.instruction);
    return Boolean((label && promptText.includes(label)) || (instruction && promptText.includes(instruction)));
  });
}

function travelReferenceSceneCoverage(project: ProjectData | null, references: string[]) {
  const referenceSet = new Set(references);
  const byPath = new Map<string, string[]>();
  const scenes = project?.scenes ?? {};
  Object.entries(scenes).forEach(([sceneName, scene]) => {
    const source = scene.asset_source;
    const sourceFile = source?.source_file?.trim();
    if (source?.source_kind !== "travel_reference" || !sourceFile || !referenceSet.has(sourceFile)) return;
    byPath.set(sourceFile, [...(byPath.get(sourceFile) ?? []), sceneName]);
  });
  const applied = references.filter((ref) => (byPath.get(ref)?.length ?? 0) > 0);
  const missing = references.filter((ref) => !applied.includes(ref));
  return { byPath, applied, missing };
}

function TravelReferenceDeliveryPanel({
  projectName,
  project,
  units,
}: {
  projectName: string;
  project: ProjectData | null;
  units: ReferenceVideoUnit[];
}) {
  const { t } = useTranslation("dashboard");
  const [applyingSceneAssets, setApplyingSceneAssets] = useState(false);
  const [sceneAssetsFixMessage, setSceneAssetsFixMessage] = useState<string | null>(null);
  if (project?.content_type !== "travel_video") return null;

  const settings = project.travel_video_settings ?? null;
  const routePreview = settings?.route_preview ?? null;
  const routeNodes = routePreview?.nodes ?? [];
  const references = travelReferenceImages(settings);
  const localReferences = references.filter(isLocalTravelReferencePath);
  const sceneCoverage = travelReferenceSceneCoverage(project, localReferences);
  const targetSeconds = travelTargetSeconds(settings);
  const totalSeconds = units.reduce((sum, unit) => sum + (unit.duration_seconds || 0), 0);
  const durationTolerance = targetSeconds ? Math.max(8, Math.round(targetSeconds * 0.2)) : 0;
  const durationDelta = targetSeconds ? totalSeconds - targetSeconds : 0;
  const durationOk = targetSeconds === null || Math.abs(durationDelta) <= durationTolerance;
  const routeReady = Boolean(routePreview?.route_ready);
  const sceneAssetsOk = localReferences.length === 0 || sceneCoverage.missing.length === 0;
  const routeNodeCoverage = units.filter((unit) => matchTravelRouteNodes(unit, routeNodes).length > 0).length;
  const unitIssues = units.reduce((count, unit) => {
    const matchedNodes = matchTravelRouteNodes(unit, routeNodes);
    const missingRouteNode = routeNodes.length > 0 && matchedNodes.length === 0;
    const missingReference = unit.references.length === 0 && references.length === 0;
    return count + (missingRouteNode || missingReference || !unit.generated_assets.video_clip ? 1 : 0);
  }, 0);
  const issueCount = unitIssues + (routeReady ? 0 : 1) + (durationOk ? 0 : 1) + (sceneAssetsOk ? 0 : 1);
  const overallReady = issueCount === 0;

  const summaryItems = [
    {
      icon: MapPinned,
      label: t("travel_delivery_route"),
      value: routeReady
        ? t("travel_delivery_route_ready", { count: routeNodes.length })
        : t("travel_delivery_route_needs_check"),
      ok: routeReady,
    },
    {
      icon: ImageIcon,
      label: t("travel_delivery_references"),
      value: t("travel_delivery_reference_count", { count: references.length }),
      ok: references.length > 0,
    },
    {
      icon: Landmark,
      label: t("travel_delivery_scene_assets"),
      value: sceneAssetsOk
        ? t("travel_delivery_scene_assets_ready", {
          applied: sceneCoverage.applied.length,
          total: localReferences.length,
        })
        : t("travel_delivery_scene_assets_missing", {
          missing: sceneCoverage.missing.length,
          total: localReferences.length,
        }),
      ok: sceneAssetsOk,
    },
    {
      icon: Clock3,
      label: t("travel_delivery_duration"),
      value: targetSeconds
        ? t("travel_delivery_duration_detail", { current: totalSeconds, target: targetSeconds })
        : t("travel_delivery_duration_custom_missing", { current: totalSeconds }),
      ok: durationOk,
    },
  ];

  const handleApplyMissingSceneAssets = async () => {
    const missing = sceneCoverage.missing.filter(isLocalTravelReferencePath);
    if (missing.length === 0 || applyingSceneAssets) return;
    setSceneAssetsFixMessage(null);
    setApplyingSceneAssets(true);
    try {
      const assetResults = await Promise.allSettled(
        missing.map((path) =>
          API.addAssetFromProjectFile({
            project_name: projectName,
            file_path: path,
            asset_type: "scene",
            name: travelReferenceAssetName(path),
            description: t("travel_route_asset_library_description", { path }),
            conflict_policy: "rename",
          }),
        ),
      );
      const savedAssets = assetResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.asset] : []
      );
      const saveFailures = assetResults.length - savedAssets.length;
      let appliedCount = 0;
      let applyFailures = 0;
      if (savedAssets.length > 0) {
        const applyResult = await API.applyAssetsToProject({
          asset_ids: savedAssets.map((asset) => asset.id),
          target_project: projectName,
          conflict_policy: "skip",
        });
        appliedCount = applyResult.succeeded.length + applyResult.skipped.length;
        applyFailures = applyResult.failed.length;
      }
      const refreshed = await API.getProject(projectName);
      useProjectsStore.getState().setCurrentProject(
        projectName,
        refreshed.project,
        refreshed.scripts ?? {},
        refreshed.asset_fingerprints,
      );
      const failures = saveFailures + applyFailures;
      if (appliedCount > 0) {
        useAppStore.getState().pushToast(
          t("travel_delivery_scene_assets_apply_done", { count: appliedCount }),
          failures > 0 ? "warning" : "success",
        );
        if (failures === 0) {
          setSceneAssetsFixMessage(t("travel_delivery_scene_assets_fix_success"));
        }
      }
      if (failures > 0) {
        useAppStore.getState().pushNotification(
          t("travel_delivery_scene_assets_apply_failed", { count: failures }),
          "error",
        );
      }
    } catch (err) {
      useAppStore.getState().pushNotification(
        t("travel_delivery_scene_assets_apply_error", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setApplyingSceneAssets(false);
    }
  };

  return (
    <section className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3">
      <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-start @3xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-200">
              <MapPinned className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-100">{t("travel_delivery_title")}</p>
              <p className="mt-0.5 text-xs leading-5 text-gray-500">
                {t("travel_delivery_desc")}
              </p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!sceneAssetsOk && (
            <button
              type="button"
              onClick={() => void handleApplyMissingSceneAssets()}
              disabled={applyingSceneAssets}
              className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1 text-xs font-medium text-cyan-100 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {applyingSceneAssets ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Landmark className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {applyingSceneAssets
                ? t("travel_delivery_scene_assets_applying")
                : t("travel_delivery_scene_assets_apply")}
            </button>
          )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              overallReady
                ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
                : "border-amber-300/25 bg-amber-400/10 text-amber-100"
            }`}
          >
            {overallReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {overallReady ? t("travel_delivery_ready") : t("travel_delivery_needs_work", { count: issueCount })}
          </span>
        </div>
      </div>

      {sceneAssetsFixMessage && (
        <div className="mt-3 rounded-lg border border-emerald-300/25 bg-emerald-400/10 px-3 py-2 text-xs leading-5 text-emerald-100">
          {sceneAssetsFixMessage}
        </div>
      )}

      <div className="mt-3 grid gap-2 @2xl:grid-cols-3">
        {summaryItems.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-lg border border-gray-800 bg-gray-950/45 px-3 py-2">
              <div className="flex items-start gap-2">
                <Icon className={`mt-0.5 h-3.5 w-3.5 ${item.ok ? "text-emerald-300" : "text-amber-200"}`} />
                <div className="min-w-0">
                  <p className="text-[11px] text-gray-500">{item.label}</p>
                  <p className="mt-1 truncate text-xs font-medium text-gray-200">{item.value}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {units.length > 0 && (
        <div className="mt-3 max-h-44 space-y-2 overflow-y-auto pr-1">
          {units.map((unit) => {
            const matchedNodes = matchTravelRouteNodes(unit, routeNodes);
            const missingRouteNode = routeNodes.length > 0 && matchedNodes.length === 0;
            const missingReference = unit.references.length === 0 && references.length === 0;
            const videoReady = Boolean(unit.generated_assets.video_clip);
            const unitTravelScenes = unit.references
              .filter((ref) => ref.type === "scene")
              .map((ref) => ref.name)
              .filter((name) => {
                const source = project.scenes?.[name]?.asset_source;
                return source?.source_kind === "travel_reference";
              });
            return (
              <div key={unit.unit_id} className="rounded-lg border border-gray-800 bg-gray-950/45 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-gray-300" translate="no">{unit.unit_id}</span>
                  <span className="rounded bg-gray-900 px-1.5 py-0.5 text-[11px] text-gray-500">
                    {unit.duration_seconds}s
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${
                    videoReady ? "bg-emerald-400/10 text-emerald-200" : "bg-amber-400/10 text-amber-100"
                  }`}>
                    {videoReady ? t("travel_delivery_unit_video_ready") : t("travel_delivery_unit_video_missing")}
                  </span>
                </div>
                <div className="mt-2 grid gap-2 @2xl:grid-cols-3">
                  <p className={`text-xs leading-5 ${missingRouteNode ? "text-amber-100" : "text-gray-400"}`}>
                    {matchedNodes.length > 0
                      ? t("travel_delivery_unit_nodes", {
                        names: matchedNodes.map((node) => node.label).join(" / "),
                      })
                      : routeNodes.length > 0
                        ? t("travel_delivery_unit_nodes_missing")
                        : t("travel_delivery_unit_nodes_manual")}
                  </p>
                  <p className={`text-xs leading-5 ${missingReference ? "text-amber-100" : "text-gray-400"}`}>
                    {unit.references.length > 0
                      ? t("travel_delivery_unit_refs", {
                        names: unit.references.map((ref) => `@${ref.name}`).join(" / "),
                      })
                      : references.length > 0
                        ? t("travel_delivery_unit_global_refs", { count: references.length })
                        : t("travel_delivery_unit_refs_missing")}
                  </p>
                  <p className={`text-xs leading-5 ${sceneAssetsOk ? "text-gray-400" : "text-amber-100"}`}>
                    {unitTravelScenes.length > 0
                      ? t("travel_delivery_unit_scene_assets", { names: unitTravelScenes.join(" / ") })
                      : sceneCoverage.applied.length > 0
                        ? t("travel_delivery_unit_scene_assets_global", {
                          applied: sceneCoverage.applied.length,
                          total: references.length,
                        })
                        : references.length > 0
                          ? t("travel_delivery_unit_scene_assets_missing", { count: references.length })
                          : t("travel_delivery_unit_scene_assets_none")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {routeNodes.length > 0 && (
        <p className="mt-2 text-[11px] leading-5 text-gray-500">
          {t("travel_delivery_route_coverage", { covered: routeNodeCoverage, total: units.length })}
        </p>
      )}
    </section>
  );
}

/** Toast an error with tone="error". Optional `format` wraps the normalized
 *  message (e.g. an i18n template); without it the raw message is shown. */
function toastError(e: unknown, format?: (msg: string) => string): void {
  const msg = errMsg(e);
  useAppStore.getState().pushToast(format ? format(msg) : msg, "error");
}

export function ReferenceVideoCanvas({ projectName, episode, episodeTitle }: ReferenceVideoCanvasProps) {
  const { t } = useTranslation("dashboard");
  const {
    checkingGenerationPreflight,
    generationPreflightDialog,
    runWithGenerationPreflight,
  } = useGenerationPreflightGate();

  const loadUnits = useReferenceVideoStore((s) => s.loadUnits);
  const addUnit = useReferenceVideoStore((s) => s.addUnit);
  const patchUnit = useReferenceVideoStore((s) => s.patchUnit);
  const generate = useReferenceVideoStore((s) => s.generate);
  const select = useReferenceVideoStore((s) => s.select);
  const handleReferenceUnitResolved = useCallback((target: WorkspaceFocusTarget) => {
    select(target.id);
  }, [select]);
  useScrollTarget("reference-unit", { onResolved: handleReferenceUnitResolved });

  const units =
    useReferenceVideoStore((s) => s.unitsByEpisode[referenceVideoCacheKey(projectName, episode)]) ??
    (EMPTY_UNITS as ReferenceVideoUnit[]);
  const selectedUnitId = useReferenceVideoStore((s) => s.selectedUnitId);
  const error = useReferenceVideoStore((s) => s.error);
  const loading = useReferenceVideoStore((s) => s.loading);
  const project = useProjectsStore((s) => s.currentProjectData);

  // Draft prompts keyed by unit_id — 只在 textarea 内容偏离服务端值时保留一条 entry。
  // 切换 unit 不清空，便于用户在多个 unit 间来回编辑而不丢失输入。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);

  const relevantTasks = useTasksStore(
    useShallow((s) =>
      s.tasks.filter(
        (tk) => tk.project_name === projectName && tk.task_type === "reference_video",
      ),
    ),
  );

  useEffect(() => {
    void loadUnits(projectName, episode);
  }, [loadUnits, projectName, episode]);

  const selected = useMemo(
    () => units.find((u) => u.unit_id === selectedUnitId) ?? null,
    [units, selectedUnitId],
  );

  // 默认选中第一个 unit；selectedUnitId 是全局单例（非 per-episode），
  // 切换 episode 后可能残留上一集的 unit_id，这里统一用 "是否在当前 units 里" 做合法性校验。
  useEffect(() => {
    if (units.length > 0 && !selected) {
      select(units[0].unit_id);
    }
  }, [units, selected, select]);

  // #370 optimistic UI：任务队列走 3s 轮询（useTasksSSE.POLL_INTERVAL_MS=3000），
  // 点击按钮到 `relevantTasks` 刷出队列记录之间存在最长 3 秒空窗期。POST 前把
  // unit_id 登记到本地 set，按钮立即显示 busy；`generating` 派生把"optimistic 置位
  // 且队列无对应行"视为真值——happy path 下终态任务在 pageSize 200 窗口里按
  // updated_at DESC 保留，hasQueueRow 持续为 true，set 遗留项永远不再激活。
  // 边界：若任务量或其他类型 churn 把该行挤出 200 条窗口，hasQueueRow 回落到
  // false，遗留项会重新激活，按钮卡在 busy 直到切换 unit 或刷新。对单会话
  // 典型规模（十到数百 unit）可接受；相比显式 pruning，派生逻辑更简单。
  const [optimisticUnitIds, setOptimisticUnitIds] = useState<Set<string>>(() => new Set());
  const isPlatformCreditsProject = project?.billing_mode === "platform_credits";
  const ensureGenerationCredits = useCallback(async () => {
    if (!isPlatformCreditsProject) return true;
    try {
      const credits = await API.getCreditBalance();
      const availableBalance = credits.available_balance ?? credits.balance;
      if (availableBalance >= credits.minimum_generation_balance) return true;
      useAppStore.getState().pushToast(
        t("platform_credits_preflight_low_balance", {
          balance: availableBalance.toLocaleString(),
          minimum: credits.minimum_generation_balance.toLocaleString(),
        }),
        "error",
      );
      return false;
    } catch {
      // If the preflight check cannot run, let the generation endpoint enforce billing.
      return true;
    }
  }, [isPlatformCreditsProject, t]);

  // #370 任务失败 toast：转变驱动（transition detection），不是状态驱动。
  //
  // 每轮 poll 记下每个 task_id 的上一次 status；只有当**上一轮不是 failed、这一轮
  // 是 failed** 时才算"刚刚发生失败"，冒泡一次 toast。首次看到一个 task 就已经是
  // failed 的（例如进页面时队列里的历史失败记录），prev 为 undefined——被视为我们
  // 没有观测到转变，保持沉默。任务后续轮询里一直是 failed，prev==="failed" 也不再
  // 触发（天然去重，不需要额外 toastedIds set）。
  //
  // 设计抉择：故意不为"3 秒轮询间隔内快速失败"的任务补齐——那种场景 POST 的 info
  // toast（"已加入生成队列"）已经告诉了用户，任务队列 HUD 也会显示状态；拿不到
  // transition 就不 toast，换来"历史失败静默"的正确语义。
  const prevTaskStatusRef = useRef<Map<string, TaskStatus>>(new Map());
  useEffect(() => {
    const prev = prevTaskStatusRef.current;
    const next = new Map<string, TaskStatus>();
    for (const tk of relevantTasks) {
      const before = prev.get(tk.task_id);
      if (tk.status === "failed" && before !== undefined && before !== "failed") {
        useAppStore.getState().pushNotification(
          t("reference_generation_task_failed", {
            unitId: tk.resource_id,
            reason: tk.error_message ?? t("reference_status_failed"),
          }),
          "error",
        );
      }
      next.set(tk.task_id, tk.status);
    }
    prevTaskStatusRef.current = next;
  }, [relevantTasks, t]);

  // "optimistic 置位 且 队列尚无对应行" OR "队列里就在 queued/running"——
  // 前者覆盖 POST→首次 poll 的 3s 空窗，后者覆盖正常运行期。队列接力后
  // 前半项天然失效，无需显式 pruning。
  const generating = useMemo(() => {
    if (!selected) return false;
    const hasQueueRow = relevantTasks.some((tk) => tk.resource_id === selected.unit_id);
    if (optimisticUnitIds.has(selected.unit_id) && !hasQueueRow) return true;
    return relevantTasks.some(
      (tk) =>
        tk.resource_id === selected.unit_id &&
      (tk.status === "queued" || tk.status === "running"),
    );
  }, [relevantTasks, selected, optimisticUnitIds]);
  const busyUnitIds = useMemo(
    () =>
      new Set(
        relevantTasks
          .filter((tk) => tk.status === "queued" || tk.status === "running")
          .map((tk) => tk.resource_id),
      ),
    [relevantTasks],
  );
  const rawMissingVideoUnits = useMemo(
    () => units.filter((unit) => !unit.generated_assets.video_clip),
    [units],
  );
  const missingVideoUnits = useMemo(
    () => rawMissingVideoUnits.filter((unit) => !busyUnitIds.has(unit.unit_id)),
    [rawMissingVideoUnits, busyUnitIds],
  );

  const handleAdd = useCallback(async () => {
    try {
      await addUnit(projectName, episode, { prompt: "", references: [] });
    } catch (e) {
      toastError(e);
    }
  }, [addUnit, projectName, episode]);

  // 小屏（<@4xl，容器 <896px）时把 editor / preview 压成 tab。@4xl+ 三栏时此状态被 CSS 忽略。
  const [smallTab, setSmallTab] = useState<"editor" | "preview">("editor");

  const handleGenerate = useCallback(
    (unitId: string) => {
      const unit = units.find((item) => item.unit_id === unitId);
      void runWithGenerationPreflight(
        {
          projectName,
          taskType: "reference_video",
          resourceId: unitId,
          targetLabel: unitId,
          payload: { duration_seconds: unit?.duration_seconds },
        },
        async () => {
          if (!(await ensureGenerationCredits())) return;
          setOptimisticUnitIds((s) => {
            if (s.has(unitId)) return s;
            const next = new Set(s);
            next.add(unitId);
            return next;
          });
          // 小屏模式下自动切到视频 Tab，让用户看到任务进入排队态；@4xl+ 下此 state 被 CSS 忽略。
          setSmallTab("preview");
          try {
            const { deduped } = await generate(projectName, episode, unitId);
            useAppStore
              .getState()
              .pushToast(
                t(deduped ? "reference_generate_deduped" : "reference_generate_queued"),
                "info",
              );
          } catch (e) {
            setOptimisticUnitIds((s) => {
              if (!s.has(unitId)) return s;
              const next = new Set(s);
              next.delete(unitId);
              return next;
            });
            toastError(e, (msg) => t("reference_generate_request_failed", { error: msg }));
          }
        },
      );
    },
    [ensureGenerationCredits, episode, generate, projectName, runWithGenerationPreflight, t, units],
  );

  const handleGenerateMissing = useCallback(() => {
    if (batchGenerating) return;
    if (missingVideoUnits.length === 0) {
      useAppStore
        .getState()
        .pushToast(
          t(
            rawMissingVideoUnits.length > 0
              ? "reference_generate_batch_already_active"
              : "reference_generate_batch_no_missing",
          ),
          "warning",
        );
      return;
    }
    const unitIds = missingVideoUnits.map((unit) => unit.unit_id);
    const maxDuration = missingVideoUnits.reduce(
      (max, unit) => Math.max(max, unit.duration_seconds ?? 0),
      0,
    );
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "reference_video",
        resourceId: `episode-${episode}-reference-videos`,
        targetLabel: t("reference_generate_batch_button", { count: missingVideoUnits.length }),
        payload: maxDuration > 0 ? { duration_seconds: maxDuration } : {},
        count: missingVideoUnits.length,
      },
      async () => {
        if (!(await ensureGenerationCredits())) return;
        setBatchGenerating(true);
        setSmallTab("preview");
        setOptimisticUnitIds((s) => {
          const next = new Set(s);
          for (const unitId of unitIds) next.add(unitId);
          return next;
        });
        try {
          const results = await Promise.allSettled(
            unitIds.map((unitId) => generate(projectName, episode, unitId)),
          );
          const submitted = results.filter((result) => result.status === "fulfilled").length;
          const failed = results.length - submitted;
          if (submitted > 0) {
            useAppStore
              .getState()
              .pushToast(t("reference_generate_batch_submitted", { count: submitted }), "info");
          }
          if (failed > 0) {
            const firstFailure = results.find((result) => result.status === "rejected");
            const reason: unknown =
              firstFailure?.status === "rejected" ? (firstFailure.reason as unknown) : undefined;
            useAppStore
              .getState()
              .pushNotification(
                t("reference_generate_batch_failed", { count: failed, error: errMsg(reason) }),
                "error",
              );
            const failedUnitIds = new Set(
              results
                .map((result, index) => (result.status === "rejected" ? unitIds[index] : null))
                .filter((unitId): unitId is string => Boolean(unitId)),
            );
            setOptimisticUnitIds((s) => {
              const next = new Set(s);
              for (const unitId of failedUnitIds) next.delete(unitId);
              return next;
            });
          }
        } finally {
          setBatchGenerating(false);
        }
      },
    );
  }, [
    batchGenerating,
    ensureGenerationCredits,
    episode,
    generate,
    missingVideoUnits,
    projectName,
    rawMissingVideoUnits.length,
    runWithGenerationPreflight,
    t,
  ]);

  const onAdd = useCallback(() => void handleAdd(), [handleAdd]);
  const onGenerateVoid = useCallback((id: string) => void handleGenerate(id), [handleGenerate]);
  const onGenerateMissingVoid = useCallback(() => void handleGenerateMissing(), [handleGenerateMissing]);

  // Draft 管理：每次输入只更新本地 drafts，不触发网络请求。草稿与服务端值一致时
  // 自动清除该条目，避免"回退到原值后仍显示未保存"的误判。
  const handlePromptChange = useCallback(
    (next: string) => {
      if (!selected) return;
      const key = draftKey(projectName, episode, selected.unit_id);
      const baseText = unitPromptText(selected);
      setDrafts((d) => {
        if (next === baseText) {
          if (!(key in d)) return d;
          const copy = { ...d };
          delete copy[key];
          return copy;
        }
        return { ...d, [key]: next };
      });
    },
    [selected, projectName, episode],
  );

  const currentText = useMemo(() => {
    if (!selected) return "";
    const base = unitPromptText(selected);
    return drafts[draftKey(projectName, episode, selected.unit_id)] ?? base;
  }, [selected, drafts, projectName, episode]);

  const isDirty = !!(
    selected &&
    (() => {
      const v = drafts[draftKey(projectName, episode, selected.unit_id)];
      return v !== undefined && v !== unitPromptText(selected);
    })()
  );

  // 全局"是否有任何未保存草稿"——用于 beforeunload 保护。
  // 复合键下无法再通过 units.find 精确匹配（跨 episode/project 的 entry 对当前 units
  // 不可见），所以只要 drafts 非空就视作有未保存改动——reasonable upper bound：
  // handlePromptChange 会在文本回到 baseText 时自动清除 entry，实际残留都是真正 dirty 的。
  const hasAnyDraft = Object.keys(drafts).length > 0;

  const handleSave = useCallback(async () => {
    if (!selected) return;
    const unitId = selected.unit_id;
    const key = draftKey(projectName, episode, unitId);
    const draftText = drafts[key];
    if (draftText === undefined || draftText === unitPromptText(selected)) return;
    const nextRefs = mergeReferences(draftText, selected.references, project ?? null);
    setSaving(true);
    try {
      await patchUnit(projectName, episode, unitId, {
        prompt: draftText,
        references: nextRefs,
      });
      // 仅当草稿未被进一步改动时才清除——否则保存期间继续输入的新文字会被一起丢弃。
      setDrafts((d) => {
        if (d[key] !== draftText) return d;
        const copy = { ...d };
        delete copy[key];
        return copy;
      });
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }, [selected, drafts, project, patchUnit, projectName, episode]);

  // 引用增删/排序保持即时保存；但若当前 unit 有未保存的 prompt 草稿，把它一并带上，
  // 让"调序顺便 persist 草稿"成为一种自然的存档路径，并避免后端 prompt 滞后于 refs。
  //
  // 注：这里刻意不用 mergeReferences(draftText, nextRefs) 去派生 references：
  //   - 与 main 分支既有契约一致（旧路径也是直发 `{prompt: pendingPrompt, references: nextRefs}`）；
  //   - 用户在 panel 侧显式移除某个 ref 但 draft 中仍保留同名 @mention 时，merge 会把
  //     该 ref 重新追加，等同于悄悄抹掉 panel 的移除意图。
  //   - @mention 与 references 之间的最终一致性由 `handleSave` 负责。
  const patchReferencesAtomic = useCallback(
    (unitId: string, nextRefs: ReferenceResource[]) => {
      const key = draftKey(projectName, episode, unitId);
      const draftText = drafts[key];
      const unit = units.find((u) => u.unit_id === unitId);
      const hasDraft =
        draftText !== undefined && unit !== undefined && draftText !== unitPromptText(unit);
      const body: { prompt?: string; references: ReferenceResource[] } = hasDraft
        ? { prompt: draftText, references: nextRefs }
        : { references: nextRefs };
      void patchUnit(projectName, episode, unitId, body)
        .then(() => {
          if (!hasDraft) return;
          // 同 handleSave 的竞态守卫：draftText 是请求启动时的快照；若请求返回前用户继续
          // 输入，d[key] 已改变，这里就不应清除——否则 textarea 回退到旧服务端值。
          setDrafts((d) => {
            if (d[key] !== draftText) return d;
            const copy = { ...d };
            delete copy[key];
            return copy;
          });
        })
        .catch((e) => {
          toastError(e);
        });
    },
    [drafts, units, patchUnit, projectName, episode],
  );

  const handleReorderRefs = useCallback(
    (next: ReferenceResource[]) => {
      if (!selected) return;
      patchReferencesAtomic(selected.unit_id, next);
    },
    [patchReferencesAtomic, selected],
  );

  const handleRemoveRef = useCallback(
    (ref: ReferenceResource) => {
      if (!selected) return;
      const next = selected.references.filter((r) => !(r.name === ref.name && r.type === ref.type));
      patchReferencesAtomic(selected.unit_id, next);
    },
    [patchReferencesAtomic, selected],
  );

  const handleAddRef = useCallback(
    (ref: ReferenceResource) => {
      if (!selected) return;
      if (selected.references.some((r) => r.type === ref.type && r.name === ref.name)) return;
      const next = [...selected.references, ref];
      patchReferencesAtomic(selected.unit_id, next);
    },
    [patchReferencesAtomic, selected],
  );

  // 预处理二级页面：默认 false（主编辑视图）；true 时整个 Canvas 内容替换为 PreprocessingView。
  // 切换 episode 或 project 时都自动退回主视图（切项目而 episode 号相同会复用组件实例，
  // 残留在预处理页会被误解为新项目也在预处理中）——用 render-phase setState 对比而非
  // useEffect，避免 react-hooks/set-state-in-effect lint 规则阻断。
  const [showPreproc, setShowPreproc] = useState(false);
  const [lastEpisode, setLastEpisode] = useState(episode);
  const [lastProject, setLastProject] = useState(projectName);
  if (lastEpisode !== episode || lastProject !== projectName) {
    setLastEpisode(episode);
    setLastProject(projectName);
    setShowPreproc(false);
  }

  // 预处理入口 / 二级页 header 上呈现的状态：loading / error / empty / ready。
  // 用 store.loading + store.error + units.length 综合推导，集中在一处，入口和 header 共用。
  const preprocStatus: PreprocStatus = loading
    ? "loading"
    : error
      ? "error"
      : units.length === 0
        ? "empty"
        : "ready";
  const preprocLabel: Record<PreprocStatus, string> = useMemo(
    () => ({
      loading: t("reference_preproc_status_loading"),
      error: t("reference_preproc_status_error"),
      empty: t("reference_preproc_status_empty"),
      ready: t("reference_units_split_complete", { count: units.length }),
    }),
    [t, units.length],
  );

  // 视频 Tab 状态圆点：综合 optimistic / 队列 / 视频产物 / 队列失败记录派生。
  // pending ← 新建未生成；running ← 任意迹象（optimistic or queued/running task）；
  // ready ← video_clip 已有；failed ← 当前 unit 最近一条任务是 failed。
  const videoStatus: UnitStatus = useMemo(() => {
    if (!selected) return "pending";
    if (generating) return "running";
    if (selected.generated_assets.video_clip) return "ready";
    const latestTask = relevantTasks.find((tk) => tk.resource_id === selected.unit_id);
    if (latestTask?.status === "failed") return "failed";
    return "pending";
  }, [selected, generating, relevantTasks]);

  // 任一 unit 有未保存草稿时，离开页面需警告。用 browser 默认弹框（不支持自定义文案）。
  useEffect(() => {
    if (!hasAnyDraft) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasAnyDraft]);

  // 二级页 header（独占整个 Canvas）：顶部返回按钮一行 + page title 行（左 title / 右 toolbar）。
  // edit/save/cancel toolbar 通过 PreprocessingView 的 renderToolbar slot 抬升到 header 右侧。
  if (showPreproc) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-gray-800 px-4 py-2">
          <button
            type="button"
            onClick={() => setShowPreproc(false)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 focus-ring"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t("reference_preproc_back")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
            <PreprocessingView
              projectName={projectName}
              episode={episode}
              contentMode="reference_video"
              compact
              renderToolbar={({ editing, saving, startEdit, save, cancel }) => (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold text-gray-100">
                      {t("reference_preproc_page_title", { episode })}
                      {episodeTitle ? <span className="text-gray-400">: {episodeTitle}</span> : null}
                    </h2>
                    <p className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                      <span className={`h-1.5 w-1.5 rounded-full ${PREPROC_DOT_CLASS[preprocStatus]}`} aria-hidden="true" />
                      <span>{preprocLabel[preprocStatus]}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          onClick={save}
                          disabled={saving}
                          className="inline-flex items-center gap-1 rounded border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 transition hover:border-emerald-500 hover:text-emerald-200 disabled:opacity-50 focus-ring"
                        >
                          {saving ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {saving ? t("common:saving") : t("common:save")}
                        </button>
                        <button
                          type="button"
                          onClick={cancel}
                          className="inline-flex items-center gap-1 rounded border border-gray-800 bg-gray-900 px-2.5 py-1 text-xs text-gray-400 transition hover:text-gray-200 focus-ring"
                        >
                          <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("common:cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={startEdit}
                        className="inline-flex items-center gap-1 rounded border border-gray-800 bg-gray-900 px-2.5 py-1 text-xs text-gray-300 transition hover:border-indigo-500 hover:text-indigo-300 focus-ring"
                      >
                        <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("common:edit")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="@container flex h-full flex-col">
      <div className="px-4 py-3">
        <h2 className="text-lg font-semibold text-gray-100">
          <span translate="no">E{episode}</span>
          {episodeTitle ? `: ${episodeTitle}` : ""}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span>{t("reference_units_count", { count: units.length })}</span>
          <span aria-hidden="true" className="text-gray-700">·</span>
          {/* 预处理入口：inline link 风格而非独立 chip——降低视觉权重的同时把状态色 + 文案 + chevron
              合到副标题行，点击进入二级页面。 */}
          <button
            type="button"
            onClick={() => setShowPreproc(true)}
            className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-gray-400 transition-colors hover:text-gray-200 focus-ring"
          >
            {preprocStatus === "loading" ? (
              <Loader2 className="h-3 w-3 animate-spin text-gray-500" aria-hidden="true" />
            ) : (
              <span className={`h-1.5 w-1.5 rounded-full ${PREPROC_DOT_CLASS[preprocStatus]}`} aria-hidden="true" />
            )}
            <span>{preprocLabel[preprocStatus]}</span>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-400">
            {error}
          </p>
        )}
          <TravelReferenceDeliveryPanel projectName={projectName} project={project} units={units} />
      </div>
      {/* 外层 grid：<@md(448px) 单列；@md+ 双栏 (UnitList | 右侧 wrapper)。
          断点选 @md 是因为 agent chat 占右半屏时中栏常在 500-700px 区间，@2xl(672px) 错过太多场景。
          单列模式显式两行：UnitList 固 40%（不超过，最少 160px），editor wrapper 拿剩余 1fr——
          否则两个子元素只有 1 个定义行、第二个落进隐式 auto 行，flex-1 链塌到 0，
          textarea 在窄屏完全不可见（#368 后续回归）。@md+ 切回 2 列 × 1 行。 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(160px,40%)_minmax(0,1fr)] overflow-hidden @md:grid-cols-[minmax(200px,30%)_1fr] @md:grid-rows-[minmax(0,1fr)]">
        <UnitList
          units={units}
          selectedId={selectedUnitId}
          onSelect={select}
          onAdd={onAdd}
        />
        {/* 右侧 wrapper：<@4xl 用 flex column (toolbar + active panel)；@4xl+ 转 grid：
            顶部 toolbar 行跨两列，下一行是 editor | preview。`display:contents` 在容器查询
            + grid 下浏览器支持不稳定，改用 grid-template-rows 让 toolbar 占自己一行。 */}
        <div className="flex min-h-0 flex-col overflow-hidden @4xl:grid @4xl:grid-cols-[1fr_minmax(260px,32%)] @4xl:grid-rows-[auto_minmax(0,1fr)]">
          {/* 统一工具条：左 = tab（仅 <@4xl）；右 = [保存(dirty 时)] + [生成视频]。
              把操作按钮浮到 tab 栏后，用户在任一 tab、任一屏宽下都能触发生成。 */}
          <div className="flex items-center gap-2 border-b border-gray-800 px-2 py-1 @4xl:col-span-2">
            <div
              role="tablist"
              aria-label={t("reference_tab_aria")}
              className="flex gap-0 @4xl:hidden"
            >
              <button
                type="button"
                role="tab"
                id="reference-tab-editor-btn"
                aria-controls="reference-tab-editor"
                aria-selected={smallTab === "editor"}
                onClick={() => setSmallTab("editor")}
                className={`relative rounded-t border-b-2 px-3 py-1.5 text-xs transition-colors focus-ring ${
                  smallTab === "editor"
                    ? "border-indigo-500 font-medium text-indigo-400"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {t("reference_tab_editor")}
                {isDirty && (
                  <span
                    aria-label={t("reference_tab_dirty_aria")}
                    className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle"
                  />
                )}
              </button>
              <button
                type="button"
                role="tab"
                id="reference-tab-preview-btn"
                aria-controls="reference-tab-preview"
                aria-selected={smallTab === "preview"}
                onClick={() => setSmallTab("preview")}
                className={`relative rounded-t border-b-2 px-3 py-1.5 text-xs transition-colors focus-ring ${
                  smallTab === "preview"
                    ? "border-indigo-500 font-medium text-indigo-400"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {t("reference_tab_preview")}
                  <span
                    aria-label={t(`reference_video_status_${videoStatus}`)}
                    className={`inline-block h-1.5 w-1.5 rounded-full align-middle ${VIDEO_DOT_CLASS[videoStatus]}`}
                  />
                </span>
              </button>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {isDirty && (
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-indigo-600 bg-indigo-600/10 px-3 py-1 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-600/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Save aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {saving ? t("common:saving") : t("common:save")}
                </button>
              )}
              {units.length > 0 && (
                <button
                  type="button"
                  onClick={onGenerateMissingVoid}
                  disabled={batchGenerating || checkingGenerationPreflight || rawMissingVideoUnits.length === 0}
                  className={`focus-ring inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                    batchGenerating
                      ? "border-emerald-700 text-emerald-400 opacity-70 cursor-not-allowed"
                      : rawMissingVideoUnits.length === 0
                        ? "cursor-not-allowed border-gray-800 text-gray-600"
                        : "border-emerald-600 text-emerald-400 hover:bg-emerald-600/10"
                  }`}
                >
                  {batchGenerating ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {batchGenerating
                    ? t("reference_generate_batch_running")
                    : rawMissingVideoUnits.length === 0
                      ? t("reference_generate_batch_complete")
                      : missingVideoUnits.length === 0
                        ? t("reference_generate_batch_active_button")
                        : t("reference_generate_batch_button", { count: missingVideoUnits.length })}
                </button>
              )}
              {selected && (
                <button
                  type="button"
                  onClick={() => onGenerateVoid(selected.unit_id)}
                  disabled={generating || checkingGenerationPreflight}
                  className={`focus-ring inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                    generating
                      ? "border-blue-700 text-blue-400 opacity-70 cursor-not-allowed"
                      : "border-blue-600 text-blue-400 hover:bg-blue-600/10"
                  }`}
                >
                  {generating ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {generating ? t("reference_preview_generating") : t("reference_preview_generate")}
                </button>
              )}
            </div>
          </div>
          <div
            role="tabpanel"
            id="reference-tab-editor"
            aria-labelledby="reference-tab-editor-btn"
            className={`min-h-0 flex-1 flex-col overflow-hidden border-r border-gray-800 bg-gray-950/30 @4xl:flex ${
              smallTab === "editor" ? "flex" : "hidden"
            }`}
          >
            {selected ? (
              <>
                <ReferencePanel
                  references={selected.references}
                  projectName={projectName}
                  onReorder={handleReorderRefs}
                  onRemove={handleRemoveRef}
                  onAdd={handleAddRef}
                />
                <div className="flex min-h-0 flex-1 flex-col p-3">
                  <ReferenceVideoCard
                    key={selected.unit_id}
                    unit={selected}
                    projectName={projectName}
                    episode={episode}
                    value={currentText}
                    onChange={handlePromptChange}
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs text-gray-600">
                {t("reference_canvas_empty")}
              </div>
            )}
          </div>
          <div
            role="tabpanel"
            id="reference-tab-preview"
            aria-labelledby="reference-tab-preview-btn"
            className={`min-h-0 overflow-hidden @4xl:block ${smallTab === "preview" ? "block" : "hidden"}`}
          >
            <UnitPreviewPanel unit={selected} projectName={projectName} />
          </div>
        </div>
      </div>
    </div>
    {generationPreflightDialog}
    </>
  );
}
