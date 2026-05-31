
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  FileText,
  Loader2,
  MapPinned,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Settings,
  WandSparkles,
  X,
} from "lucide-react";
import { useLocation } from "wouter";
import type { EpisodeMeta, ProjectArchiveModelRuleAuditManifest, ProjectData, TravelRouteAssetManifest } from "@/types";
import { API, ApiRequestError, ConflictError } from "@/api";
import { AuthenticatedImage } from "@/components/ui/AuthenticatedMedia";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useCostStore } from "@/stores/cost-store";
import { useTasksStore } from "@/stores/tasks-store";
import { getContentTypePreset } from "@/data/content-types";
import { formatCost, totalBreakdown } from "@/utils/cost-format";
import { errMsg } from "@/utils/async";
import { effectiveMode } from "@/utils/generation-mode";
import {
  countProjectExportAlerts,
  countProjectExportPreflightIssues,
  firstDeliveryReportIssueEpisode,
  hasTravelRouteAssetManifest,
  loadProjectExportPreflight,
  prepareProjectExport,
  shouldShowProjectExportPreflightDialog,
  triggerPreparedProjectDownload,
  type PreparedProjectExport,
  type ProjectExportDownloadResult,
  type ProjectExportPreflightResult,
} from "@/utils/project-export";
import { getActiveGenerationResourceIds } from "@/utils/generation-tasks";
import {
  buildProjectDeliverySummary,
  hasProjectExportGateIssues,
  isEpisodeTask,
  type ProjectDeliveryEpisodeCheck,
  type ProjectDeliverySummary,
} from "@/utils/project-delivery";
import {
  getProjectWorkflowCurrentPhase,
  getProjectWorkflowNextStage,
  getProjectWorkflowStages,
  type ProjectWorkflowStage,
  WORKFLOW_PHASES,
} from "@/utils/project-workflow";
import { rememberAssetLibraryReturnTo } from "@/utils/asset-library-return";
import { getScriptByFileKey, getScriptGenerationItems, normalizeScriptFileKey } from "@/utils/script-generation";

import { WelcomeCanvas } from "./WelcomeCanvas";
import { ConflictModal, type ConflictResolution } from "./ConflictModal";
import { ArchiveDiagnosticsDialog } from "@/components/shared/ArchiveDiagnosticsDialog";
import { ProjectPreExportDialog } from "@/components/shared/ProjectPreExportDialog";
import { useGenerationPreflightGate } from "@/components/ui/GenerationPreflight";

interface OverviewCanvasProps {
  projectName: string;
  projectData: ProjectData | null;
}

function episodeNextActionKey(ep: EpisodeMeta): string {
  if (ep.script_status === "segmented") return "episode_next_generate_script";
  if (ep.script_status !== "generated") return "episode_next_create_draft";
  if (ep.status === "completed") return "episode_next_export";
  if ((ep.videos?.total ?? 0) > (ep.videos?.completed ?? 0) || ep.status === "in_production") {
    return "episode_next_finish_videos";
  }
  if (ep.status === "scripted") return "episode_next_produce";
  return "episode_next_open";
}

function isInsufficientCreditsError(err: unknown): boolean {
  if (err instanceof ApiRequestError) return err.status === 402;
  return Boolean(err && typeof err === "object" && (err as { status?: unknown }).status === 402);
}

function firstRejectedReason(results: readonly PromiseSettledResult<unknown>[]): unknown {
  const firstFailure = results.find((result) => result.status === "rejected");
  return firstFailure?.status === "rejected" ? firstFailure.reason : undefined;
}

function ProjectDeliverySummaryPanel({
  summary,
  busy,
  exporting,
  retrying,
  reporting,
  auditing,
  onHandleNext,
  onExport,
  onOpenReport,
  onOpenModelRuleAudit,
  onOpenEpisode,
}: {
  summary: ProjectDeliverySummary;
  busy: boolean;
  exporting: boolean;
  retrying: boolean;
  reporting: boolean;
  auditing: boolean;
  onHandleNext: () => void;
  onExport: () => void;
  onOpenReport: () => void;
  onOpenModelRuleAudit: () => void;
  onOpenEpisode: (episode: number) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const ready = summary.totalEpisodes > 0 && summary.blockingIssues === 0;
  const mainBusy = busy || exporting || retrying || reporting || auditing;
  const nextEpisode = summary.firstAction?.episode;
  const nextActionKey = summary.firstAction
    ? summary.firstAction.action === "retry_failed"
      ? "project_delivery_action_retry_failed"
      : summary.firstAction.action === "generate_script"
        ? "project_delivery_action_generate_script"
        : "project_delivery_action_fix_episode"
    : "project_delivery_action_export";

  const stats = [
    { key: "episodes", label: t("project_delivery_stat_episodes"), value: `${summary.readyEpisodes} / ${summary.totalEpisodes}`, icon: CheckCircle2 },
    { key: "scripts", label: t("project_delivery_stat_scripts"), value: `${summary.scriptedEpisodes} / ${summary.totalEpisodes}`, icon: PlayCircle },
    { key: "storyboards", label: t("project_delivery_stat_storyboards"), value: `${summary.storyboardReady} / ${summary.storyboardTotal}`, icon: WandSparkles },
    { key: "videos", label: t("project_delivery_stat_videos"), value: `${summary.videoReady} / ${summary.videoTotal}`, icon: PlayCircle },
    { key: "failed", label: t("project_delivery_stat_failed"), value: String(summary.failedTasks), icon: AlertTriangle },
  ];

  return (
    <section className={`rounded-xl border p-4 ${
      ready ? "border-emerald-400/25 bg-emerald-500/5" : "border-amber-400/25 bg-amber-500/5"
    }`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {ready ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-300" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-300" />
            )}
            <h3 className="text-sm font-semibold text-gray-100">{t("project_delivery_title")}</h3>
          </div>
          <p className="mt-1 text-sm leading-6 text-gray-400">
            {ready
              ? summary.missingThumbnails > 0
                ? t("project_delivery_ready_with_warnings", { count: summary.missingThumbnails })
                : t("project_delivery_ready")
              : t("project_delivery_needs_work", {
                count: summary.blockingIssues,
                episode: nextEpisode?.episode ?? "-",
              })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenReport}
            disabled={reporting || summary.totalEpisodes === 0}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
          >
            {reporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            {t("project_delivery_action_report")}
          </button>
          <button
            type="button"
            onClick={onOpenModelRuleAudit}
            disabled={auditing}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
          >
            {auditing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            {t("project_delivery_action_model_rule_audit")}
          </button>
          <button
            type="button"
            onClick={ready ? onExport : onHandleNext}
            disabled={mainBusy || summary.totalEpisodes === 0 || (!ready && !summary.firstAction)}
            className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-ring ${
              ready
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-indigo-600 text-white hover:bg-indigo-500"
            }`}
          >
            {mainBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : ready ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            {ready ? t("project_delivery_action_export") : t(nextActionKey)}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map(({ key, label, value, icon: Icon }) => (
          <div key={key} className="rounded-lg border border-gray-800 bg-gray-950/55 p-3">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
            </div>
            <p className="mt-1 font-mono text-sm text-gray-200">{value}</p>
          </div>
        ))}
      </div>

      {summary.episodes.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-gray-800 bg-gray-950/45">
          {summary.episodes.map((check) => {
            const episodeReady = check.blockingIssues === 0;
            return (
              <button
                key={check.episode.episode}
                type="button"
                onClick={() => onOpenEpisode(check.episode.episode)}
                className="grid w-full gap-3 border-b border-gray-800 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-gray-900/70 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {episodeReady ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-amber-300" />
                    )}
                    <span className="font-mono text-xs text-gray-500">E{check.episode.episode}</span>
                    <span className="truncate text-sm font-medium text-gray-100">{check.episode.title}</span>
                    {check.activeTasks > 0 && (
                      <span className="rounded border border-indigo-400/20 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] text-indigo-200">
                        {t("project_delivery_episode_active", { count: check.activeTasks })}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-gray-500">
                    {t("project_delivery_episode_detail", {
                      script: check.scriptReady ? t("project_delivery_yes") : t("project_delivery_no"),
                      storyboards: `${check.storyboardReady}/${check.storyboardTotal}`,
                      videos: `${check.videoReady}/${check.videoTotal}`,
                      failed: check.failedTasks,
                    })}
                  </p>
                </div>
                <span className={`self-center rounded-md border px-2 py-1 text-xs ${
                  episodeReady
                    ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
                    : check.failedTasks > 0
                      ? "border-red-400/25 bg-red-500/10 text-red-100"
                      : "border-amber-400/25 bg-amber-500/10 text-amber-100"
                }`}>
                  {episodeReady
                    ? t("project_delivery_episode_ready")
                    : check.failedTasks > 0
                      ? t("project_delivery_episode_failed")
                      : t("project_delivery_episode_needs_work")}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

type QuickStartStepKey = "overview" | "assets" | "episode" | "script" | "referenceVideo";
type QuickStartStepStatus = "pending" | "running" | "done" | "warning" | "failed" | "skipped";
type QuickStartAssetKind = "characters" | "scenes" | "props";
type OverviewActionFeedback =
  | { tone: "success" | "warning"; message: string }
  | { tone: "error"; message: string; retry: OverviewActionRetry };

type OverviewActionRetry =
  | { kind: "asset_prepare"; mode: "lists" | "full" }
  | { kind: "quickstart"; startFrom: QuickStartStepKey };

interface TravelRouteAssetSaveResult {
  savedPaths: string[];
  failed: number;
}

interface QuickStartStepState {
  key: QuickStartStepKey;
  status: QuickStartStepStatus;
  detail?: string;
}

const QUICK_START_STEPS: Array<{
  key: QuickStartStepKey;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    key: "overview",
    labelKey: "workflow_quickstart_step_overview",
    descriptionKey: "workflow_quickstart_step_overview_desc",
  },
  {
    key: "assets",
    labelKey: "workflow_quickstart_step_assets",
    descriptionKey: "workflow_quickstart_step_assets_desc",
  },
  {
    key: "episode",
    labelKey: "workflow_quickstart_step_episode",
    descriptionKey: "workflow_quickstart_step_episode_desc",
  },
];

interface QuickStartPlan {
  steps: typeof QUICK_START_STEPS;
  assetKinds: QuickStartAssetKind[];
  needsFinalScript: boolean;
  needsReferenceVideo: boolean;
  requiresTravelRoute: boolean;
}

function hasTravelVideoRoute(projectData: ProjectData | null | undefined): boolean {
  if (projectData?.content_type !== "travel_video") return true;
  const settings = projectData.travel_video_settings;
  const origin = settings?.origin?.trim();
  const destination = settings?.destination?.trim();
  const routeNotes = settings?.route_notes?.trim();
  const referenceImages = Array.isArray(settings?.reference_images)
    ? settings.reference_images.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  return Boolean(routeNotes || (origin && destination) || referenceImages.length > 0);
}

function createQuickStartPlan(projectData: ProjectData | null | undefined): QuickStartPlan {
  const preset = getContentTypePreset(projectData?.content_type);
  const generationMode = preset?.generationMode ?? projectData?.generation_mode;
  const contentMode = preset?.contentMode ?? projectData?.content_mode;
  const needsReferenceVideo = generationMode === "reference_video";
  const assetKinds: QuickStartAssetKind[] =
    !preset
      ? ["characters", "scenes", "props"]
      : preset.id === "travel_video" || preset.id === "narration_story"
        ? ["scenes"]
        : contentMode === "drama" || preset.id === "education_sketch"
          ? ["characters", "scenes", "props"]
          : ["scenes"];
  const assetStep =
    preset?.id === "travel_video"
      ? {
        key: "assets" as const,
        labelKey: "workflow_quickstart_step_route_assets",
        descriptionKey: "workflow_quickstart_step_route_assets_desc",
      }
      : contentMode === "narration"
        ? {
          key: "assets" as const,
          labelKey: "workflow_quickstart_step_visual_assets",
          descriptionKey: "workflow_quickstart_step_visual_assets_desc",
        }
        : QUICK_START_STEPS[1];

  return {
    steps: [
      QUICK_START_STEPS[0],
      ...(assetKinds.length > 0 ? [assetStep] : []),
      QUICK_START_STEPS[2],
      ...(needsReferenceVideo
        ? [
          {
            key: "script" as const,
            labelKey: "workflow_quickstart_step_script",
            descriptionKey: "workflow_quickstart_step_script_desc",
          },
          {
            key: "referenceVideo" as const,
            labelKey: "workflow_quickstart_step_reference_video",
            descriptionKey: "workflow_quickstart_step_reference_video_desc",
          },
        ]
        : []),
    ],
    assetKinds,
    needsFinalScript: needsReferenceVideo,
    needsReferenceVideo,
    requiresTravelRoute: preset?.id === "travel_video",
  };
}

function createQuickStartSteps(stepDefinitions: typeof QUICK_START_STEPS): QuickStartStepState[] {
  return stepDefinitions.map((step) => ({ key: step.key, status: "pending" }));
}

function QuickStartProgressPanel({
  steps,
  stepDefinitions,
  running,
  onRetry,
}: {
  steps: QuickStartStepState[];
  stepDefinitions: typeof QUICK_START_STEPS;
  running: boolean;
  onRetry: (step: QuickStartStepKey) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const statusMeta: Record<QuickStartStepStatus, { label: string; className: string }> = {
    pending: {
      label: t("workflow_quickstart_status_pending"),
      className: "border-gray-700 bg-gray-900 text-gray-500",
    },
    running: {
      label: t("workflow_quickstart_status_running"),
      className: "border-indigo-300/35 bg-indigo-500/10 text-indigo-100",
    },
    done: {
      label: t("workflow_quickstart_status_done"),
      className: "border-emerald-300/35 bg-emerald-500/10 text-emerald-100",
    },
    warning: {
      label: t("workflow_quickstart_status_warning"),
      className: "border-amber-300/35 bg-amber-300/10 text-amber-100",
    },
    failed: {
      label: t("workflow_quickstart_status_failed"),
      className: "border-red-300/35 bg-red-400/10 text-red-100",
    },
    skipped: {
      label: t("workflow_quickstart_status_skipped"),
      className: "border-sky-300/30 bg-sky-400/10 text-sky-100",
    },
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/45 p-3">
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
        {stepDefinitions.map((step, index) => {
          const state = steps.find((item) => item.key === step.key) ?? { key: step.key, status: "pending" };
          const meta = statusMeta[state.status];
          const Icon =
            state.status === "running"
              ? Loader2
              : state.status === "failed"
                ? AlertTriangle
                : state.status === "done" || state.status === "warning" || state.status === "skipped"
                  ? CheckCircle2
                  : Circle;
          return (
            <div
              key={step.key}
              className={`min-w-0 rounded-lg border p-3 ${meta.className}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${state.status === "running" ? "animate-spin" : ""}`} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] opacity-70">{index + 1}</span>
                      <span className="text-sm font-semibold">{t(step.labelKey)}</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 opacity-75">{state.detail || t(step.descriptionKey)}</p>
                  </div>
                </div>
                <span className="shrink-0 rounded-md bg-black/20 px-1.5 py-0.5 text-[11px]">
                  {meta.label}
                </span>
              </div>
              {state.status === "failed" && (
                <button
                  type="button"
                  onClick={() => onRetry(step.key)}
                  disabled={running}
                  className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-current/25 px-2 py-1.5 text-xs font-medium transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("workflow_quickstart_retry_step")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverviewActionFeedbackPanel({
  feedback,
  busy,
  onRetry,
}: {
  feedback: OverviewActionFeedback;
  busy: boolean;
  onRetry: (retry: OverviewActionRetry) => void;
}) {
  const { t } = useTranslation("dashboard");
  const toneClass = feedback.tone === "success"
    ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
    : feedback.tone === "warning"
      ? "border-amber-300/25 bg-amber-400/10 text-amber-100"
      : "border-red-300/25 bg-red-400/10 text-red-100";

  return (
    <div className={`flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm leading-6 sm:flex-row sm:items-center sm:justify-between ${toneClass}`}>
      <p className="min-w-0">{feedback.message}</p>
      {feedback.tone === "error" && (
        <button
          type="button"
          onClick={() => onRetry(feedback.retry)}
          disabled={busy}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-current/25 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("overview_action_retry")}
        </button>
      )}
    </div>
  );
}

function formatTravelSettingValue(value: string | null | undefined, fallback: string) {
  const text = value?.trim();
  return text ? text : fallback;
}

function getTravelReferencePreviewSrc(projectName: string, path: string | null | undefined, usable = true) {
  const value = path?.trim();
  if (!value || !usable) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return API.getFileUrl(projectName, value);
}

function getTravelReferenceSearchTerm(path: string) {
  const lastPart = path.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  return lastPart.replace(/\.[a-z0-9]+$/i, "") || lastPart;
}

function getAppliedTravelReferenceScenes(projectData: ProjectData | null | undefined) {
  const applied = new Map<string, string[]>();
  const scenes = projectData?.scenes;
  if (!scenes || typeof scenes !== "object") return applied;

  Object.entries(scenes).forEach(([sceneName, scene]) => {
    const source = scene?.asset_source;
    if (!source || source.source_kind !== "travel_reference") return;
    const sourceFile = source.source_file?.trim();
    if (!sourceFile) return;
    applied.set(sourceFile, [...(applied.get(sourceFile) ?? []), sceneName]);
  });
  return applied;
}

function isLocalTravelReferencePath(path: string) {
  const value = path.trim();
  return Boolean(value) && !value.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function getLocalTravelReferenceImages(projectData: ProjectData | null | undefined) {
  const raw = projectData?.travel_video_settings?.reference_images;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const refs: string[] = [];
  raw.forEach((item) => {
    if (typeof item !== "string") return;
    const value = item.trim();
    if (!isLocalTravelReferencePath(value) || seen.has(value)) return;
    seen.add(value);
    refs.push(value);
  });
  return refs;
}

function getTravelRouteAssetNodeTarget(node: TravelRouteAssetManifest["nodes"][number]) {
  const detail = node.matched_unit_details?.find((item) =>
    item.id &&
    typeof item.episode === "number" && Number.isFinite(item.episode) && item.episode > 0
  );
  if (!detail || typeof detail.episode !== "number") return null;
  return { episode: detail.episode, unitId: detail.id };
}

function TravelRouteAssetPreviewDialog({
  projectName,
  manifest,
  appliedReferenceScenes,
  onOpenUnit,
  onFindReferenceAsset,
  onSaveReferenceAsset,
  onSaveAllReferenceAssets,
  onClose,
}: {
  projectName: string;
  manifest: TravelRouteAssetManifest;
  appliedReferenceScenes: Map<string, string[]>;
  onOpenUnit: (target: { episode: number; unitId: string }) => void;
  onFindReferenceAsset: (path: string) => void;
  onSaveReferenceAsset: (path: string) => Promise<void>;
  onSaveAllReferenceAssets: (paths: string[]) => Promise<TravelRouteAssetSaveResult>;
  onClose: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const [savingReferencePath, setSavingReferencePath] = useState<string | null>(null);
  const [savingAllReferences, setSavingAllReferences] = useState(false);
  const [savedReferencePaths, setSavedReferencePaths] = useState<string[]>([]);
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);
  const missingNodes = manifest.nodes.filter((node) => !node.covered);
  const savedReferencePathSet = new Set(savedReferencePaths);
  const isAppliedReference = (path: string) =>
    appliedReferenceScenes.has(path) || savedReferencePathSet.has(path);
  const savableReferencePaths = Array.from(new Set(
    manifest.reference_images.items
      .filter((ref) =>
        ref.kind === "local" &&
        ref.usable &&
        ref.path.trim() &&
        !isAppliedReference(ref.path)
      )
      .map((ref) => ref.path),
  ));
  const savingAnyReference = savingReferencePath !== null || savingAllReferences;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
      <div className="max-h-[86vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-gray-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MapPinned className="h-5 w-5 text-cyan-200" />
              <h2 className="text-lg font-semibold text-gray-100">{t("travel_route_asset_preview_title")}</h2>
            </div>
            <p className="mt-1 text-sm leading-6 text-gray-400">{t("travel_route_asset_preview_desc")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
          >
            {t("common:close")}
          </button>
        </div>

        <div className="max-h-[calc(86vh-76px)] overflow-y-auto p-5">
          <section className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-cyan-200/80">
                  {t("travel_route_asset_preview_route")}
                </p>
                <h3 className="mt-1 text-base font-semibold text-gray-100">
                  {manifest.route.summary || t("travel_route_preview_no_summary")}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t("delivery_report_travel_route_origin_destination", {
                    origin: manifest.route.origin ?? "-",
                    destination: manifest.route.destination ?? "-",
                  })}
                </p>
              </div>
              <div className="grid min-w-[280px] gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                  <p className="text-[11px] text-gray-500">{t("delivery_report_travel_route_coverage")}</p>
                  <p className="mt-1 font-mono text-sm text-gray-100">
                    {manifest.node_coverage.covered} / {manifest.node_coverage.total}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                  <p className="text-[11px] text-gray-500">{t("delivery_report_travel_route_references")}</p>
                  <p className="mt-1 font-mono text-sm text-gray-100">
                    {manifest.reference_images.usable} / {manifest.reference_images.total}
                  </p>
                </div>
              </div>
            </div>
            {missingNodes.length > 0 && (
              <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
                {t("delivery_report_travel_route_missing_nodes", {
                  nodes: missingNodes.map((node) => node.label || node.id).slice(0, 6).join(", "),
                })}
              </p>
            )}
            <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-xs leading-5 text-gray-400">
              <p className="font-medium text-gray-200">{t("delivery_report_travel_route_asset_manifest_title")}</p>
              <p className="mt-1">{t("delivery_report_travel_route_asset_manifest_desc")}</p>
              <p className="mt-1 text-cyan-100/80">{t("travel_route_asset_preview_open_episode_hint")}</p>
              <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px] text-gray-300">
                <span className="rounded bg-gray-900 px-2 py-1">output/scenelet-travel-route-assets.html</span>
                <span className="rounded bg-gray-900 px-2 py-1">output/scenelet-travel-route-assets.json</span>
              </div>
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-sm font-semibold text-gray-200">{t("travel_route_asset_preview_nodes")}</h3>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {manifest.nodes.length > 0 ? manifest.nodes.map((node, index) => {
                const targetUnit = getTravelRouteAssetNodeTarget(node);
                const targetEpisode = targetUnit?.episode ?? null;
                const unitDetailsById = new Map((node.matched_unit_details ?? []).map((item) => [item.id, item]));
                const openEpisode = () => {
                  if (targetUnit === null) return;
                  onOpenUnit(targetUnit);
                };

                return (
                  <div
                    key={node.id || `${node.label}-${index}`}
                    role={targetEpisode === null ? undefined : "button"}
                    tabIndex={targetEpisode === null ? undefined : 0}
                    onClick={openEpisode}
                    onKeyDown={(event) => {
                      if (targetEpisode === null) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openEpisode();
                      }
                    }}
                    className={`rounded-xl border bg-gray-900/70 p-4 transition-colors ${
                      targetEpisode === null
                        ? "border-gray-800"
                        : "cursor-pointer border-cyan-400/30 hover:border-cyan-300/60 hover:bg-gray-900 focus-ring"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-400/10 text-xs font-semibold text-cyan-100">
                            {index + 1}
                          </span>
                          <h4 className="truncate text-sm font-semibold text-gray-100">{node.label || node.id}</h4>
                        </div>
                        <p className="mt-2 line-clamp-3 text-sm leading-6 text-gray-400">
                          {node.instruction || t("travel_route_preview_node_empty")}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <span className={`rounded-full border px-2 py-1 text-xs ${
                          node.covered
                            ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
                            : "border-amber-300/25 bg-amber-400/10 text-amber-100"
                        }`}>
                          {node.covered ? t("travel_route_asset_preview_node_covered") : t("travel_route_asset_preview_node_missing")}
                        </span>
                        {targetEpisode !== null && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-100">
                            {t("travel_route_asset_preview_open_episode")}
                            <ArrowRight className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <div>
                        <p className="text-[11px] text-gray-500">{t("travel_route_asset_preview_matched_units")}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {node.matched_units.length > 0 ? node.matched_units.map((unit) => {
                            const detail = unitDetailsById.get(unit);
                            const episodeLabel = typeof detail?.episode === "number"
                              ? t("travel_route_asset_preview_unit_episode", { episode: detail.episode })
                              : "";
                            const label = [unit, episodeLabel, detail?.title].filter(Boolean).join(" · ");
                            return (
                              <span key={unit} className="rounded-md bg-emerald-400/10 px-2 py-1 font-mono text-[11px] text-emerald-100">{label}</span>
                            );
                          }) : (
                            <span className="text-xs text-gray-500">{t("travel_route_asset_preview_no_units")}</span>
                          )}
                        </div>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-500">{t("travel_route_asset_preview_linked_refs")}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {node.reference_images.length > 0 ? node.reference_images.map((ref) => (
                            <span key={ref} className="rounded-md bg-cyan-400/10 px-2 py-1 font-mono text-[11px] text-cyan-100">{ref}</span>
                          )) : (
                            <span className="text-xs text-gray-500">{t("travel_route_asset_preview_no_refs")}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }) : (
                <div className="rounded-xl border border-dashed border-gray-800 p-4 text-sm text-gray-500">
                  {t("travel_route_asset_preview_no_nodes")}
                </div>
              )}
            </div>
          </section>

          <section className="mt-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-sm font-semibold text-gray-200">{t("travel_route_asset_preview_refs")}</h3>
              {savableReferencePaths.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSavingAllReferences(true);
                    setSaveSuccessMessage(null);
                    void onSaveAllReferenceAssets(savableReferencePaths)
                      .then((result) => {
                        if (result.savedPaths.length > 0) {
                          setSavedReferencePaths((prev) => Array.from(new Set([...prev, ...result.savedPaths])));
                        }
                        setSaveSuccessMessage(
                          result.failed > 0
                            ? t("travel_route_asset_preview_save_all_partial_success", {
                              count: result.savedPaths.length,
                              failed: result.failed,
                            })
                            : t("travel_route_asset_preview_save_all_success", {
                              count: result.savedPaths.length,
                            }),
                        );
                      })
                      .catch(() => undefined)
                      .finally(() => setSavingAllReferences(false));
                  }}
                  disabled={savingAnyReference}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300/25 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:border-emerald-300/50 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingAllReferences ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t("travel_route_asset_preview_saving_all_to_library")}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("travel_route_asset_preview_save_all_to_library", { count: savableReferencePaths.length })}
                    </>
                  )}
                </button>
              )}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {manifest.reference_images.items.length > 0 ? manifest.reference_images.items.map((ref) => {
                const src = getTravelReferencePreviewSrc(projectName, ref.path, ref.usable);
                const appliedScenes = appliedReferenceScenes.get(ref.path) ?? [];
                const alreadyApplied = appliedScenes.length > 0 || savedReferencePathSet.has(ref.path);
                const canSaveToLibrary = ref.kind === "local" && ref.usable && !alreadyApplied;
                const savingThisReference = savingReferencePath === ref.path || savingAllReferences;
                return (
                  <article key={ref.id || ref.path} className="rounded-xl border border-gray-800 bg-gray-900/70 p-3">
                    <div className="aspect-video overflow-hidden rounded-lg border border-gray-800 bg-gray-950">
                      {src ? (
                        <AuthenticatedImage src={src} alt={ref.path} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-gray-500">
                          {t("travel_route_asset_preview_ref_unavailable")}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 flex items-start justify-between gap-2">
                      <p className="min-w-0 break-all font-mono text-xs text-gray-300">{ref.path}</p>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
                        alreadyApplied
                          ? "border-cyan-300/25 bg-cyan-400/10 text-cyan-100"
                          : ref.usable
                          ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
                          : "border-amber-300/25 bg-amber-400/10 text-amber-100"
                      }`}>
                        {alreadyApplied
                          ? t("travel_route_asset_preview_ref_applied")
                          : ref.usable
                            ? t("travel_route_asset_preview_ref_usable")
                            : t("travel_route_asset_preview_ref_missing")}
                      </span>
                    </div>
                    {alreadyApplied && appliedScenes.length > 0 && (
                      <p className="mt-2 line-clamp-2 rounded-lg border border-cyan-300/15 bg-cyan-400/5 px-2 py-1.5 text-[11px] leading-5 text-cyan-100/80">
                        {t("travel_route_asset_preview_ref_applied_scenes", {
                          scenes: appliedScenes.slice(0, 3).join(", "),
                        })}
                      </p>
                    )}
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSavingReferencePath(ref.path);
                          setSaveSuccessMessage(null);
                          void onSaveReferenceAsset(ref.path)
                            .then(() => {
                              setSavedReferencePaths((prev) => Array.from(new Set([...prev, ref.path])));
                              setSaveSuccessMessage(t("travel_route_asset_preview_save_one_success", {
                                name: getTravelReferenceSearchTerm(ref.path),
                              }));
                            })
                            .catch(() => undefined)
                            .finally(() => setSavingReferencePath(null));
                        }}
                        disabled={!canSaveToLibrary || savingAnyReference}
                        className="inline-flex items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-400/10 px-2.5 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:border-emerald-300/50 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {alreadyApplied
                          ? t("travel_route_asset_preview_save_to_library_applied")
                          : savingThisReference
                            ? t("travel_route_asset_preview_saving_to_library")
                            : t("travel_route_asset_preview_save_to_library")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!src) return;
                          window.open(src, "_blank", "noopener,noreferrer");
                        }}
                        disabled={!src}
                        className="inline-flex items-center justify-center rounded-lg border border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("travel_route_asset_preview_open_reference")}
                      </button>
                      <button
                        type="button"
                        onClick={() => onFindReferenceAsset(ref.path)}
                        className="inline-flex items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-2.5 py-1.5 text-xs font-medium text-cyan-100 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/15"
                      >
                        {t("travel_route_asset_preview_find_in_library")}
                      </button>
                    </div>
                  </article>
                );
              }) : (
                <div className="rounded-xl border border-dashed border-gray-800 p-4 text-sm text-gray-500">
                  {t("travel_route_asset_preview_no_reference_images")}
                </div>
              )}
            </div>
            {saveSuccessMessage && (
              <p className="mt-3 rounded-lg border border-emerald-300/25 bg-emerald-400/10 px-3 py-2 text-xs leading-5 text-emerald-100">
                {saveSuccessMessage}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ModelRuleAuditPreviewDialog({
  manifest,
  onOpenRules,
  onOpenTask,
  onClose,
}: {
  manifest: ProjectArchiveModelRuleAuditManifest;
  onOpenRules: (ruleTarget?: string | null) => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const visibleItems = manifest.items.slice(0, 100);
  const hiddenCount = Math.max(manifest.items.length - visibleItems.length, 0);
  const modeLabel = (mode: string | null | undefined, fallback?: string | null) => {
    const value = mode ?? "";
    if (["default", "prompt", "github_skill", "uploaded_skill"].includes(value)) {
      return t(`model_rule_mode_${value}` as Parameters<typeof t>[0]);
    }
    return fallback || value || "-";
  };
  const mediaLabel = (mediaType: string | null | undefined) => {
    if (mediaType === "image") return t("image_generation");
    if (mediaType === "video") return t("video_generation");
    if (mediaType === "text") return t("text_generation");
    return mediaType || "-";
  };
  const billingLabel = (billingMode: string | null | undefined) => {
    if (billingMode === "platform_credits") return t("model_rule_audit_billing_platform_credits");
    if (billingMode === "byok") return t("model_rule_audit_billing_byok");
    return billingMode || t("task_model_rule_unknown_billing");
  };
  const statusLabel = (status: string | null | undefined) => {
    const value = status ?? "";
    if (["queued", "running", "succeeded", "failed", "cancelled"].includes(value)) {
      return t(`task_filter_status_${value}` as Parameters<typeof t>[0]);
    }
    return value || "-";
  };
  const counterSummary = (
    counts: Record<string, number>,
    labeler: (value: string) => string,
  ) => {
    const parts = Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count))
      .map(([key, count]) => `${labeler(key)} ${count}`);
    return parts.length > 0 ? parts.join(" / ") : "-";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
      <div className="max-h-[86vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-gray-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-indigo-200" />
              <h2 className="text-lg font-semibold text-gray-100">{t("model_rule_audit_preview_title")}</h2>
            </div>
            <p className="mt-1 text-sm leading-6 text-gray-400">{t("model_rule_audit_preview_desc")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenRules()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/35 bg-indigo-500/10 px-3 py-1.5 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-500/15"
            >
              <Settings className="h-4 w-4" />
              {t("model_rule_audit_preview_open_rules")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
            >
              {t("common:close")}
            </button>
          </div>
        </div>

        <div className="max-h-[calc(86vh-76px)] overflow-y-auto p-5">
          <section className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-4">
            <div className="grid gap-2 md:grid-cols-4">
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                <p className="text-[11px] text-gray-500">{t("model_rule_audit_preview_total")}</p>
                <p className="mt-1 font-mono text-sm text-gray-100">{manifest.total}</p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 md:col-span-2">
                <p className="text-[11px] text-gray-500">{t("model_rule_audit_preview_modes")}</p>
                <p className="mt-1 break-words text-sm text-gray-100">
                  {counterSummary(manifest.by_mode, (value) => modeLabel(value))}
                </p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                <p className="text-[11px] text-gray-500">{t("model_rule_audit_preview_media")}</p>
                <p className="mt-1 break-words text-sm text-gray-100">
                  {counterSummary(manifest.by_media_type, mediaLabel)}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2 text-xs leading-5 text-gray-500 sm:flex-row sm:items-center sm:justify-between">
              <span>{t("model_rule_audit_preview_generated_at", { time: manifest.generated_at ?? "-" })}</span>
              <span>{t("model_rule_audit_preview_project", { project: manifest.project_name ?? "-" })}</span>
            </div>
            {manifest.artifact_files.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 font-mono text-[11px] text-gray-300">
                {manifest.artifact_files.map((file) => (
                  <span key={file} className="rounded bg-gray-900 px-2 py-1">{file}</span>
                ))}
              </div>
            )}
          </section>

          <section className="mt-4">
            <h3 className="text-sm font-semibold text-gray-200">{t("model_rule_audit_preview_tasks")}</h3>
            <div className="mt-3 space-y-2">
              {visibleItems.length > 0 ? visibleItems.map((item) => {
                const rule = item.rule;
                const target = rule.target_label || [rule.provider_id, rule.model_id].filter(Boolean).join(" / ") || "-";
                const skill = rule.skill_name || t("task_model_rule_no_skill");
                const ruleTarget = rule.rule_target?.trim() || null;
                return (
                  <article key={item.task_id} className="rounded-xl border border-gray-800 bg-gray-900/70 p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md bg-gray-950 px-2 py-1 font-mono text-[11px] text-gray-300">
                            {item.resource_id || item.task_id}
                          </span>
                          <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400">
                            {statusLabel(item.status)}
                          </span>
                          <span className="rounded-full border border-indigo-300/25 bg-indigo-400/10 px-2 py-0.5 text-[11px] text-indigo-100">
                            {mediaLabel(rule.media_type ?? item.media_type)}
                          </span>
                          <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-[11px] text-cyan-100">
                            {modeLabel(rule.mode, rule.mode_label)}
                          </span>
                        </div>
                        <h4 className="mt-2 break-words text-sm font-semibold text-gray-100">{target}</h4>
                        <div className="mt-2 grid gap-1.5 text-xs leading-5 text-gray-500 sm:grid-cols-2">
                          <span>{t("model_rule_audit_preview_skill", { skill })}</span>
                          <span>{t("model_rule_audit_preview_billing", { billing: billingLabel(rule.billing_mode) })}</span>
                          <span>{t("model_rule_audit_preview_script", { script: item.script_file || "-" })}</span>
                          <span>{t("model_rule_audit_preview_source", { source: item.source || "-" })}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-left text-xs leading-5 text-gray-500 md:text-right">
                        <p>{t("model_rule_audit_preview_updated_at", { time: item.updated_at || item.finished_at || item.queued_at || "-" })}</p>
                        <p className="font-mono text-[11px] text-gray-600">{item.task_id}</p>
                        <button
                          type="button"
                          onClick={() => onOpenTask(item.task_id)}
                          className="mt-2 inline-flex items-center justify-center gap-1 rounded-lg border border-sky-400/30 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-100 transition-colors hover:bg-sky-500/15"
                        >
                          <Activity className="h-3 w-3" />
                          {t("model_rule_audit_preview_open_task")}
                        </button>
                        {ruleTarget && (
                          <button
                            type="button"
                            onClick={() => onOpenRules(ruleTarget)}
                            className="mt-2 ml-2 inline-flex items-center justify-center rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-100 transition-colors hover:bg-indigo-500/15"
                          >
                            {t("model_rule_audit_preview_open_item_rule")}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              }) : (
                <div className="rounded-xl border border-dashed border-gray-800 p-5 text-sm text-gray-500">
                  {t("model_rule_audit_preview_empty")}
                </div>
              )}
            </div>
            {hiddenCount > 0 && (
              <p className="mt-3 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2 text-sm text-gray-400">
                {t("model_rule_audit_preview_more", { count: hiddenCount })}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function TravelVideoRoutePreviewPanel({
  projectName,
  projectData,
  aspectRatioLabel,
  onOpenSettings,
  onOpenAssetManifest,
  assetManifestLoading,
}: {
  projectName: string;
  projectData: ProjectData;
  aspectRatioLabel: string;
  onOpenSettings: () => void;
  onOpenAssetManifest: () => void;
  assetManifestLoading: boolean;
}) {
  const { t } = useTranslation("dashboard");
  if (projectData.content_type !== "travel_video") return null;

  const settings = projectData.travel_video_settings ?? {};
  const routePreview = settings.route_preview ?? null;
  const routeReady = routePreview ? routePreview.route_ready : hasTravelVideoRoute(projectData);
  const empty = t("travel_video_preview_empty");
  const origin = formatTravelSettingValue(settings.origin ?? routePreview?.origin, t("travel_video_preview_origin_missing"));
  const destination = formatTravelSettingValue(settings.destination ?? routePreview?.destination, t("travel_video_preview_destination_missing"));
  const routeNotes = formatTravelSettingValue(settings.route_notes, t("travel_video_preview_route_notes_empty"));
  const routeSource = settings.route_source ?? "google_street_view";
  const narrationLanguage = settings.narration_language ?? "auto";
  const targetDuration = settings.target_duration ?? "45s";
  const customDurationSeconds =
    typeof settings.custom_duration_seconds === "number" && Number.isFinite(settings.custom_duration_seconds) && settings.custom_duration_seconds > 0
      ? Math.round(settings.custom_duration_seconds)
      : null;
  const targetDurationLabel = targetDuration === "custom"
    ? `${t("travel_video_duration_custom")}${customDurationSeconds ? ` · ${customDurationSeconds}s` : ""}`
    : t(`travel_video_duration_${targetDuration}`);
  const cameraStyle = settings.camera_style ?? "street_walk_turns";
  const narratorPersona = settings.narrator_persona ?? "enthusiastic_guide";
  const characterNotes = formatTravelSettingValue(settings.character_notes, empty);
  const referenceImages = Array.isArray(settings.reference_images)
    ? settings.reference_images.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  return (
    <section className="overflow-hidden rounded-xl border border-cyan-400/20 bg-cyan-500/5">
      <div className="flex flex-col gap-3 border-b border-cyan-400/10 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-200">
              <MapPinned className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-gray-100">{t("travel_video_preview_title")}</h3>
              <p className="mt-0.5 text-sm leading-5 text-gray-500">{t("travel_video_preview_desc")}</p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              routeReady
                ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
                : "border-amber-300/25 bg-amber-400/10 text-amber-100"
            }`}
          >
            {routeReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {routeReady ? t("travel_video_preview_ready") : t("travel_video_preview_missing")}
          </span>
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 transition-colors hover:border-cyan-300/40 hover:bg-cyan-500/10 hover:text-cyan-100"
          >
            <Settings className="h-3.5 w-3.5" />
            {t("travel_video_preview_open_settings")}
          </button>
          <button
            type="button"
            onClick={onOpenAssetManifest}
            disabled={assetManifestLoading}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:bg-cyan-300/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {assetManifestLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            {assetManifestLoading ? t("travel_route_asset_preview_loading") : t("travel_route_asset_preview_button")}
          </button>
        </div>
      </div>

      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-cyan-200/80">
            {t("travel_video_preview_route")}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
            <div className="min-w-0 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2">
              <p className="text-[11px] text-gray-500">{t("travel_video_origin")}</p>
              <p className="mt-1 truncate text-sm font-medium text-gray-100">{origin}</p>
            </div>
            <ArrowRight className="hidden h-4 w-4 text-cyan-200/70 sm:block" />
            <div className="min-w-0 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2">
              <p className="text-[11px] text-gray-500">{t("travel_video_destination")}</p>
              <p className="mt-1 truncate text-sm font-medium text-gray-100">{destination}</p>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2">
            <p className="text-[11px] text-gray-500">{t("travel_video_route_notes")}</p>
            <p className="mt-1 line-clamp-3 text-sm leading-6 text-gray-300">{routeNotes}</p>
          </div>
          {routePreview && (
            <div className="mt-3 rounded-lg border border-cyan-400/15 bg-cyan-400/5 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-cyan-200/80">
                  {t("travel_video_route_preview_result")}
                </p>
                <span className="rounded-md border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] text-cyan-100">
                  {t(`travel_route_preview_source_${routePreview.source}`)}
                </span>
              </div>
              <p className="mt-2 text-sm font-medium leading-5 text-gray-100">
                {routePreview.summary || t("travel_route_preview_no_summary")}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-gray-800 bg-gray-950/55 px-2.5 py-2">
                  <p className="text-[11px] text-gray-500">{t("travel_video_route_preview_distance")}</p>
                  <p className="mt-1 text-sm font-medium text-gray-200">
                    {routePreview.distance_text || t("travel_route_preview_unknown_distance")}
                  </p>
                </div>
                <div className="rounded-md border border-gray-800 bg-gray-950/55 px-2.5 py-2">
                  <p className="text-[11px] text-gray-500">{t("travel_video_route_preview_duration")}</p>
                  <p className="mt-1 text-sm font-medium text-gray-200">
                    {routePreview.duration_text || t("travel_route_preview_unknown_duration")}
                  </p>
                </div>
              </div>
              {routePreview.nodes.length > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] text-gray-500">{t("travel_video_route_preview_nodes")}</p>
                  <div className="mt-2 space-y-2">
                    {routePreview.nodes.slice(0, 4).map((node, index) => (
                      <div key={node.id || `${node.label}-${index}`} className="rounded-md border border-gray-800 bg-gray-950/55 px-2.5 py-2">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-400/10 text-[11px] font-semibold text-cyan-100">
                            {index + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-gray-100">{node.label}</p>
                            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-400">
                              {node.instruction || t("travel_route_preview_node_empty")}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {routePreview.warnings.length > 0 && (
                <div className="mt-3 rounded-md border border-amber-300/20 bg-amber-300/10 px-2.5 py-2">
                  <p className="text-[11px] font-medium text-amber-100">{t("travel_video_route_preview_warnings")}</p>
                  <ul className="mt-1 space-y-1 text-xs leading-5 text-amber-100/90">
                    {routePreview.warnings.slice(0, 3).map((warning) => (
                      <li key={warning.code}>{warning.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {referenceImages.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] text-gray-500">{t("travel_video_reference_images")}</p>
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {referenceImages.slice(0, 4).map((path) => (
                  <AuthenticatedImage
                    key={path}
                    src={API.getFileUrl(projectName, path)}
                    alt={t("travel_video_reference_image_alt")}
                    className="aspect-video rounded-md border border-gray-800 object-cover"
                  />
                ))}
              </div>
            </div>
          )}
          <p className={`mt-3 text-xs leading-5 ${routeReady ? "text-emerald-200/80" : "text-amber-100"}`}>
            {routeReady ? t("travel_video_preview_confirm_hint") : t("travel_video_preview_missing_hint")}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          {[
            [t("travel_video_route_source"), t(`travel_video_route_source_${routeSource}`)],
            [t("travel_video_preview_aspect_ratio"), aspectRatioLabel],
            [t("travel_video_target_duration"), targetDurationLabel],
            [t("travel_video_camera_style"), t(`travel_video_camera_style_${cameraStyle}`)],
            [t("travel_video_language"), t(`travel_video_language_${narrationLanguage}`)],
            [t("travel_video_narrator_persona"), t(`travel_video_narrator_${narratorPersona}`)],
            [t("travel_video_reference_images"), t("travel_video_reference_count", { count: referenceImages.length })],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
              <p className="text-[11px] text-gray-500">{label}</p>
              <p className="mt-1 truncate text-sm font-medium text-gray-200">{value}</p>
            </div>
          ))}
          <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 sm:col-span-2 lg:col-span-1">
            <p className="text-[11px] text-gray-500">{t("travel_video_character_notes")}</p>
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-gray-300">{characterNotes}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function OverviewCanvas({ projectName, projectData }: OverviewCanvasProps) {
  const { t } = useTranslation("dashboard");
  const {
    checkingGenerationPreflight,
    generationPreflightDialog,
    runWithGenerationPreflight,
  } = useGenerationPreflightGate();
  const [, setLocation] = useLocation();
  const tRef = useRef(t);
  tRef.current = t;
  const projectTotals = useCostStore((s) => s.costData?.project_totals);
  const getEpisodeCost = useCostStore((s) => s.getEpisodeCost);
  const costLoading = useCostStore((s) => s.loading);
  const costError = useCostStore((s) => s.error);
  const debouncedFetch = useCostStore((s) => s.debouncedFetch);
  const currentScripts = useProjectsStore((s) => s.currentScripts);
  const tasks = useTasksStore((s) => s.tasks);

  useEffect(() => {
    if (!projectName) return;
    debouncedFetch(projectName);
  }, [projectName, projectData?.episodes, debouncedFetch]);

  const [regenerating, setRegenerating] = useState(false);
  const [assetPrepMode, setAssetPrepMode] = useState<"lists" | "full" | null>(null);
  const [generatingEpisodeDraft, setGeneratingEpisodeDraft] = useState<number | null>(null);
  const [generatingEpisodeScript, setGeneratingEpisodeScript] = useState<number | null>(null);
  const [generatingProductionEpisode, setGeneratingProductionEpisode] = useState<number | null>(null);
  const [retryingDeliveryEpisode, setRetryingDeliveryEpisode] = useState<number | null>(null);
  const [guidedWorkflowRunning, setGuidedWorkflowRunning] = useState(false);
  const quickStartPlan = useMemo(
    () => createQuickStartPlan(projectData),
    [projectData],
  );
  const [quickStartSteps, setQuickStartSteps] = useState<QuickStartStepState[]>(
    () => createQuickStartSteps(quickStartPlan.steps),
  );
  const [workflowGuideActive, setWorkflowGuideActive] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("workflow") === "quickstart";
  });
  const [exportingProject, setExportingProject] = useState(false);
  const [overviewActionFeedback, setOverviewActionFeedback] = useState<OverviewActionFeedback | null>(null);
  const [exportResult, setExportResult] = useState<ProjectExportDownloadResult | null>(null);
  const [backendExportPrompt, setBackendExportPrompt] = useState<PreparedProjectExport | null>(null);
  const [deliveryReportPreview, setDeliveryReportPreview] = useState<ProjectExportPreflightResult | null>(null);
  const [deliveryReportLoading, setDeliveryReportLoading] = useState(false);
  const [modelRuleAuditPreview, setModelRuleAuditPreview] = useState<ProjectArchiveModelRuleAuditManifest | null>(null);
  const [modelRuleAuditLoading, setModelRuleAuditLoading] = useState(false);
  const [travelRouteAssetPreview, setTravelRouteAssetPreview] = useState<ProjectExportPreflightResult | null>(null);
  const [travelRouteAssetLoading, setTravelRouteAssetLoading] = useState(false);
  const autoOpenedTravelRouteAssetsRef = useRef(false);
  const [preExportPrompt, setPreExportPrompt] = useState<ProjectDeliverySummary | null>(null);
  const [conflictPrompt, setConflictPrompt] = useState<{
    existing: string;
    suggestedName: string;
    resolve: (d: ConflictResolution) => void;
  } | null>(null);

  useEffect(() => {
    setQuickStartSteps((prev) => {
      const prevKeys = prev.map((step) => step.key).join("|");
      const nextKeys = quickStartPlan.steps.map((step) => step.key).join("|");
      return prevKeys === nextKeys ? prev : createQuickStartSteps(quickStartPlan.steps);
    });
  }, [quickStartPlan.steps]);

  const refreshProject = useCallback(
    async (): Promise<ProjectData> => {
      const res = await API.getProject(projectName);
      useProjectsStore.getState().setCurrentProject(
        projectName,
        res.project,
        res.scripts ?? {},
        res.asset_fingerprints,
      );
      return res.project;
    },
    [projectName],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      const tryUpload = async (
        onConflict?: "fail" | "replace" | "rename"
      ): Promise<void> => {
        const res = await API.uploadFile(projectName, "source", file, null, {
          onConflict,
        });
        const filename = res.filename ?? file.name;
        const enc = res.used_encoding ?? null;
        const chapters = res.chapter_count ?? 0;
        const hasEncoding = enc !== null;
        let key: string;
        if (hasEncoding && chapters > 0) {
          key = "source_normalized_toast_with_chapters";
        } else if (hasEncoding) {
          key = "source_normalized_toast";
        } else if (chapters > 0) {
          key = "source_normalized_toast_native_with_chapters";
        } else {
          key = "source_normalized_toast_native";
        }
        useAppStore
          .getState()
          .pushToast(
            tRef.current(key, { filename, encoding: enc, chapters }),
            "success",
          );
      };

      try {
        await tryUpload();
      } catch (err) {
        if (err instanceof ConflictError) {
          const decision = await new Promise<ConflictResolution>((resolve) => {
            setConflictPrompt({
              existing: err.existing,
              suggestedName: err.suggestedName,
              resolve,
            });
          });
          setConflictPrompt(null);
          if (decision === "cancel") return;
          await tryUpload(decision);
        } else {
          throw err;
        }
      }
    },
    [projectName],
  );

  const handleAnalyze = useCallback(async () => {
    await API.generateOverview(projectName);
    await refreshProject();
  }, [projectName, refreshProject]);

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      await API.generateOverview(projectName);
      await refreshProject();
      useAppStore.getState().pushToast(tRef.current("project_overview_regenerated"), "success");
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("regenerate_failed", { message: errMsg(err) }), "error");
    } finally {
      setRegenerating(false);
    }
  }, [projectName, refreshProject]);

  const clearWorkflowGuideParam = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("workflow") !== "quickstart") return;
    url.searchParams.delete("workflow");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const dismissWorkflowGuide = useCallback(() => {
    setWorkflowGuideActive(false);
    clearWorkflowGuideParam();
  }, [clearWorkflowGuideParam]);

  const setQuickStartStep = useCallback(
    (key: QuickStartStepKey, status: QuickStartStepStatus, detail?: string) => {
      setQuickStartSteps((prev) =>
        prev.map((step) => (step.key === key ? { ...step, status, detail } : step)),
      );
    },
    [],
  );

  const resetQuickStartStepsFrom = useCallback((startFrom: QuickStartStepKey) => {
    const startIndex = Math.max(0, quickStartPlan.steps.findIndex((step) => step.key === startFrom));
    setQuickStartSteps((prev) =>
      prev.map((step, index) =>
        index >= startIndex
          ? { ...step, status: "pending", detail: undefined }
          : step,
      ),
    );
  }, [quickStartPlan.steps]);

  const handleRunGuidedWorkflow = useCallback(async (startFrom: QuickStartStepKey = "overview"): Promise<boolean> => {
    if (guidedWorkflowRunning || !projectData) return false;
    setOverviewActionFeedback(null);
    const activeSteps = quickStartPlan.steps;
    const startIndex = Math.max(0, activeSteps.findIndex((step) => step.key === startFrom));
    const shouldRunStep = (key: QuickStartStepKey) => {
      const stepIndex = activeSteps.findIndex((step) => step.key === key);
      return stepIndex >= 0 && startIndex <= stepIndex;
    };
    const runAssetList = (kind: QuickStartAssetKind) => {
      if (kind === "characters") return API.generateProjectCharacters(projectName);
      if (kind === "scenes") return API.generateProjectScenes(projectName);
      return API.generateProjectProps(projectName);
    };
    setWorkflowGuideActive(true);
    resetQuickStartStepsFrom(startFrom);
    setGuidedWorkflowRunning(true);
    try {
      let latest = projectData;
      let changed = 0;
      let targetEpisode = 1;
      let routeReferenceWarnings = 0;

      if (shouldRunStep("overview")) {
        if (latest.overview) {
          setQuickStartStep("overview", "skipped", tRef.current("workflow_quickstart_step_overview_existing"));
        } else {
          setQuickStartStep("overview", "running");
          try {
            await API.generateOverview(projectName);
            latest = await refreshProject();
            setQuickStartStep("overview", "done", tRef.current("workflow_quickstart_step_overview_done"));
          } catch (err) {
            setQuickStartStep("overview", "failed", errMsg(err));
            throw err;
          }
        }
      }

      if (shouldRunStep("assets")) {
        setQuickStartStep("assets", "running");
        if (quickStartPlan.requiresTravelRoute) {
          if (!hasTravelVideoRoute(latest)) {
            const message = tRef.current("workflow_quickstart_step_route_required");
            setQuickStartStep("assets", "failed", message);
            throw new Error(message);
          }

          setQuickStartStep("assets", "running", tRef.current("workflow_quickstart_step_route_previewing"));
          try {
            const routePreview = await API.previewTravelRoute(projectName, latest.travel_video_settings ?? {}, { persist: true });
            if (!routePreview.route_ready) {
              const message =
                routePreview.warnings?.[0]?.message ||
                tRef.current("workflow_quickstart_step_route_preview_incomplete");
              setQuickStartStep("assets", "failed", message);
              throw new Error(message);
            }

            const warningCount = routePreview.warnings?.length ?? 0;
            const routeSummary =
              routePreview.summary ||
              [routePreview.origin, routePreview.destination].filter(Boolean).join(" -> ") ||
              tRef.current("travel_route_preview_ready");
            setQuickStartStep(
              "assets",
              "running",
              warningCount > 0
                ? tRef.current("workflow_quickstart_step_route_preview_warning", { count: warningCount })
                : tRef.current("workflow_quickstart_step_route_preview_done", { summary: routeSummary }),
            );

            const localReferenceImages = getLocalTravelReferenceImages(latest);
            const appliedReferences = getAppliedTravelReferenceScenes(latest);
            const missingReferenceImages = localReferenceImages.filter((path) => !appliedReferences.has(path));
            if (missingReferenceImages.length > 0) {
              setQuickStartStep(
                "assets",
                "running",
                tRef.current("workflow_quickstart_step_route_references_applying", {
                  count: missingReferenceImages.length,
                }),
              );
              const assetResults = await Promise.allSettled(
                missingReferenceImages.map((path) =>
                  API.addAssetFromProjectFile({
                    project_name: projectName,
                    file_path: path,
                    asset_type: "scene",
                    name: getTravelReferenceSearchTerm(path),
                    description: tRef.current("travel_route_asset_library_description", { path }),
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
                try {
                  const applyResult = await API.applyAssetsToProject({
                    asset_ids: savedAssets.map((asset) => asset.id),
                    target_project: projectName,
                    conflict_policy: "skip",
                  });
                  appliedCount = applyResult.succeeded.length + applyResult.skipped.length;
                  applyFailures = applyResult.failed.length;
                } catch {
                  applyFailures = savedAssets.length;
                }
              }
              changed += appliedCount;
              routeReferenceWarnings += saveFailures + applyFailures;
              setQuickStartStep(
                "assets",
                routeReferenceWarnings > 0 ? "warning" : "running",
                routeReferenceWarnings > 0
                  ? tRef.current("workflow_quickstart_step_route_references_warning", {
                    count: appliedCount,
                    failed: routeReferenceWarnings,
                  })
                  : tRef.current("workflow_quickstart_step_route_references_applied", { count: appliedCount }),
              );
            } else if (localReferenceImages.length > 0) {
              setQuickStartStep("assets", "running", tRef.current("workflow_quickstart_step_route_references_all_applied"));
            } else {
              setQuickStartStep("assets", "running", tRef.current("workflow_quickstart_step_route_references_none"));
            }

            latest = await refreshProject();
          } catch (err) {
            setQuickStartStep("assets", "failed", errMsg(err));
            throw err;
          }
        }
        const listResults = await Promise.allSettled(quickStartPlan.assetKinds.map((kind) => runAssetList(kind)));
        const generatedLists = listResults.filter((result) => result.status === "fulfilled");
        const listFailures = listResults.length - generatedLists.length;
        changed += generatedLists.reduce((sum, item) => sum + item.value.added + item.value.updated, 0);
        if (generatedLists.length === 0) {
          const reason = firstRejectedReason(listResults);
          const message = errMsg(reason, tRef.current("asset_prepare_no_lists"));
          setQuickStartStep("assets", "failed", message);
          throw reason instanceof Error ? reason : new Error(message);
        }
        if (listFailures + routeReferenceWarnings > 0) {
          setQuickStartStep(
            "assets",
            "warning",
            tRef.current("workflow_quickstart_step_assets_warning", {
              count: listFailures + routeReferenceWarnings,
              changed,
            }),
          );
          useAppStore
            .getState()
            .pushNotification(tRef.current("workflow_quickstart_asset_warnings", {
              count: listFailures + routeReferenceWarnings,
            }), "warning");
        } else {
          setQuickStartStep(
            "assets",
            "done",
            tRef.current("workflow_quickstart_step_assets_done", { changed }),
          );
        }
        try {
          latest = await refreshProject();
        } catch (err) {
          setQuickStartStep("assets", "failed", errMsg(err));
          throw err;
        }
      }

      if (shouldRunStep("episode")) {
        setQuickStartStep("episode", "running");
        latest = shouldRunStep("assets") ? latest : await refreshProject();
        const episodes = latest.episodes ?? [];
        const target = episodes.find((ep) => ep.script_status !== "generated") ?? episodes[0];
        targetEpisode = target?.episode ?? 1;

        try {
          if (episodes.length === 0) {
            const draft = await API.generateEpisodeDraft(projectName, 1);
            targetEpisode = draft.episode;
            latest = await refreshProject();
            setQuickStartStep(
              "episode",
              "done",
              tRef.current("workflow_quickstart_step_episode_draft_done", { episode: targetEpisode }),
            );
          } else if (!quickStartPlan.needsFinalScript && target?.script_status === "segmented") {
            await API.generateEpisodeScript(projectName, target.episode);
            targetEpisode = target.episode;
            latest = await refreshProject();
            setQuickStartStep(
              "episode",
              "done",
              tRef.current("workflow_quickstart_step_episode_script_done", { episode: targetEpisode }),
            );
          } else {
            setQuickStartStep(
              "episode",
              "skipped",
              tRef.current("workflow_quickstart_step_episode_existing", { episode: targetEpisode }),
            );
          }
        } catch (err) {
          setQuickStartStep("episode", "failed", errMsg(err));
          throw err;
        }
      }

      if (shouldRunStep("script")) {
        setQuickStartStep("script", "running");
        latest = await refreshProject();
        let episodes = latest.episodes ?? [];
        let target = episodes.find((ep) => ep.episode === targetEpisode)
          ?? episodes.find((ep) => ep.script_status !== "generated")
          ?? episodes[0];

        try {
          if (!target) {
            const draft = await API.generateEpisodeDraft(projectName, targetEpisode);
            targetEpisode = draft.episode;
            latest = await refreshProject();
            episodes = latest.episodes ?? [];
            target = episodes.find((ep) => ep.episode === targetEpisode) ?? episodes[0];
          }

          targetEpisode = target?.episode ?? targetEpisode;
          if (target?.script_status === "generated") {
            setQuickStartStep(
              "script",
              "skipped",
              tRef.current("workflow_quickstart_step_script_existing", { episode: targetEpisode }),
            );
          } else {
            await API.generateEpisodeScript(projectName, targetEpisode);
            latest = await refreshProject();
            setQuickStartStep(
              "script",
              "done",
              tRef.current("workflow_quickstart_step_script_done", { episode: targetEpisode }),
            );
          }
        } catch (err) {
          setQuickStartStep("script", "failed", errMsg(err));
          throw err;
        }
      }

      if (shouldRunStep("referenceVideo")) {
        setQuickStartStep("referenceVideo", "running");
        try {
          latest = await refreshProject();
          const episodes = latest.episodes ?? [];
          const target = episodes.find((ep) => ep.episode === targetEpisode) ?? episodes[0];
          targetEpisode = target?.episode ?? targetEpisode;
          const busyUnitIds = new Set(
            tasks
              .filter(
                (task) =>
                  task.project_name === projectName &&
                  task.task_type === "reference_video" &&
                  (task.status === "queued" || task.status === "running"),
              )
              .map((task) => task.resource_id),
          );
          const { units } = await API.listReferenceVideoUnits(projectName, targetEpisode);
          const rawMissingUnits = units.filter((unit) => !unit.generated_assets.video_clip);
          const missingUnits = rawMissingUnits.filter((unit) => !busyUnitIds.has(unit.unit_id));

          if (units.length === 0) {
            setQuickStartStep("referenceVideo", "warning", tRef.current("workflow_quickstart_step_reference_video_no_units"));
          } else if (missingUnits.length === 0) {
            setQuickStartStep(
              "referenceVideo",
              "skipped",
              tRef.current(
                rawMissingUnits.length > 0
                  ? "workflow_quickstart_step_reference_video_active"
                  : "workflow_quickstart_step_reference_video_existing",
              ),
            );
          } else {
            const results = await Promise.allSettled(
              missingUnits.map((unit) => API.generateReferenceVideoUnit(projectName, targetEpisode, unit.unit_id)),
            );
            const submitted = results.filter((result) => result.status === "fulfilled").length;
            const failed = results.length - submitted;
            if (submitted === 0) {
              const reason = firstRejectedReason(results);
              const message = errMsg(reason, tRef.current("reference_generate_request_failed", { error: "" }));
              setQuickStartStep("referenceVideo", "failed", message);
              throw reason instanceof Error ? reason : new Error(message);
            }
            setQuickStartStep(
              "referenceVideo",
              failed > 0 ? "warning" : "done",
              tRef.current(
                failed > 0
                  ? "workflow_quickstart_step_reference_video_warning"
                  : "workflow_quickstart_step_reference_video_done",
                { count: submitted, failed },
              ),
            );
          }
        } catch (err) {
          setQuickStartStep("referenceVideo", "failed", errMsg(err));
          throw err;
        }
      }

      dismissWorkflowGuide();
      const successMessage = tRef.current("workflow_quickstart_completed", { changed, episode: targetEpisode });
      setOverviewActionFeedback({ tone: "success", message: successMessage });
      useAppStore.getState().pushToast(successMessage, "success");
      setLocation(`/episodes/${targetEpisode}`);
      return true;
    } catch (err) {
      const failureMessage = tRef.current("workflow_quickstart_failed", { message: errMsg(err) });
      setOverviewActionFeedback({
        tone: "error",
        message: failureMessage,
        retry: { kind: "quickstart", startFrom },
      });
      useAppStore.getState().pushNotification(failureMessage, "error");
      return false;
    } finally {
      setGuidedWorkflowRunning(false);
    }
  }, [
    dismissWorkflowGuide,
    guidedWorkflowRunning,
    projectData,
    projectName,
    quickStartPlan,
    refreshProject,
    resetQuickStartStepsFrom,
    setLocation,
    setQuickStartStep,
    tasks,
  ]);

  const handleRunGuidedWorkflowWithPreflight = useCallback(
    async (startFrom: QuickStartStepKey = "overview"): Promise<boolean> => {
      if (checkingGenerationPreflight) return false;
      let completed = false;
      await runWithGenerationPreflight(
        {
          projectName,
          taskType: "workflow",
          resourceId: `quickstart-${startFrom}`,
          targetLabel: tRef.current("workflow_quickstart_button"),
          payload: { start_from: startFrom },
        },
        async () => {
          completed = await handleRunGuidedWorkflow(startFrom);
        },
      );
      return completed;
    },
    [
      checkingGenerationPreflight,
      handleRunGuidedWorkflow,
      projectName,
      runWithGenerationPreflight,
    ],
  );

  const handlePrepareAssets = useCallback(async (mode: "lists" | "full" = "full") => {
    if (assetPrepMode) return;
    setOverviewActionFeedback(null);
    setAssetPrepMode(mode);
    try {
      if (!projectData?.overview) {
        await API.generateOverview(projectName);
      }

      const listResults = await Promise.allSettled([
        API.generateProjectCharacters(projectName),
        API.generateProjectScenes(projectName),
        API.generateProjectProps(projectName),
      ]);
      const generatedLists = listResults.filter((result) => result.status === "fulfilled");
      if (generatedLists.length === 0) {
        const firstFailure = listResults.find((result) => result.status === "rejected");
        throw firstFailure?.status === "rejected" ? firstFailure.reason : new Error(tRef.current("asset_prepare_no_lists"));
      }

      const refreshed = await refreshProject();
      let canSubmitDesigns = mode === "full";
      if (mode === "full" && refreshed.billing_mode === "platform_credits") {
        try {
          const credits = await API.getCreditBalance();
          const availableBalance = credits.available_balance ?? credits.balance;
          if (availableBalance < credits.minimum_generation_balance) {
            canSubmitDesigns = false;
            useAppStore.getState().pushNotification(
              tRef.current("asset_prepare_low_credits", {
                balance: availableBalance.toLocaleString(),
                minimum: credits.minimum_generation_balance.toLocaleString(),
              }),
              "error",
            );
          }
        } catch {
          canSubmitDesigns = true;
        }
      }

      let submitted = 0;
      let failed = 0;
      if (mode === "full" && canSubmitDesigns) {
        const activeCharacterNames = getActiveGenerationResourceIds(tasks, projectName, "character");
        const activeSceneNames = getActiveGenerationResourceIds(tasks, projectName, "scene");
        const activePropNames = getActiveGenerationResourceIds(tasks, projectName, "prop");
        const designTasks = [
          ...Object.entries(refreshed.characters ?? {})
            .filter(([name, character]) => !character.character_sheet && !activeCharacterNames.has(name))
            .map(([name, character]) => () => API.generateCharacter(projectName, name, character.description ?? "")),
          ...Object.entries(refreshed.scenes ?? {})
            .filter(([name, scene]) => !scene.scene_sheet && !activeSceneNames.has(name))
            .map(([name, scene]) => () => API.generateProjectScene(projectName, name, scene.description ?? "")),
          ...Object.entries(refreshed.props ?? {})
            .filter(([name, prop]) => !prop.prop_sheet && !activePropNames.has(name))
            .map(([name, prop]) => () => API.generateProjectProp(projectName, name, prop.description ?? "")),
        ];
        const designResults = await Promise.allSettled(designTasks.map((run) => run()));
        submitted = designResults.filter((result) => result.status === "fulfilled").length;
        failed = designResults.length - submitted;
      }

      const changed = generatedLists.reduce((sum, item) => sum + item.value.added + item.value.updated, 0);
      const listFailed = listResults.length - generatedLists.length;
      const totalFailed = failed + listFailed;
      const successMessage = tRef.current(
        mode === "full" ? "asset_prepare_completed" : "asset_prepare_lists_completed",
        { changed, submitted, failed: totalFailed },
      );
      setOverviewActionFeedback({
        tone: totalFailed > 0 ? "warning" : "success",
        message: successMessage,
      });
      useAppStore.getState().pushToast(successMessage, totalFailed > 0 ? "warning" : "success");
    } catch (err) {
      const failureMessage = tRef.current("asset_prepare_failed", { message: errMsg(err) });
      setOverviewActionFeedback({
        tone: "error",
        message: failureMessage,
        retry: { kind: "asset_prepare", mode },
      });
      useAppStore.getState().pushNotification(failureMessage, "error");
    } finally {
      setAssetPrepMode(null);
    }
  }, [assetPrepMode, projectData?.overview, projectName, refreshProject, tasks]);

  const handleGenerateEpisodeDraft = useCallback(async (episode: number) => {
    if (generatingEpisodeDraft !== null) return;
    setGeneratingEpisodeDraft(episode);
    try {
      const result = await API.generateEpisodeDraft(projectName, episode);
      await refreshProject();
      useAppStore
        .getState()
        .pushToast(tRef.current("episode_draft_generated", { episode: result.episode }), "success");
      setLocation(`/episodes/${result.episode}`);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("episode_draft_failed", { message: errMsg(err) }), "error");
    } finally {
      setGeneratingEpisodeDraft(null);
    }
  }, [generatingEpisodeDraft, projectName, refreshProject, setLocation]);
  const handleGenerateFirstEpisodeDraft = useCallback(
    async () => handleGenerateEpisodeDraft(1),
    [handleGenerateEpisodeDraft],
  );

  const handleGenerateEpisodeScript = useCallback(async (episode: number) => {
    if (generatingEpisodeScript !== null) return;
    setGeneratingEpisodeScript(episode);
    try {
      await API.generateEpisodeScript(projectName, episode);
      await refreshProject();
      useAppStore
        .getState()
        .pushToast(tRef.current("episode_script_generated", { episode }), "success");
      setLocation(`/episodes/${episode}`);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("episode_script_failed", { message: errMsg(err) }), "error");
    } finally {
      setGeneratingEpisodeScript(null);
    }
  }, [generatingEpisodeScript, projectName, refreshProject, setLocation]);

  const ensureGenerationCredits = useCallback(async () => {
    if (projectData?.billing_mode !== "platform_credits") return true;
    try {
      const credits = await API.getCreditBalance();
      const availableBalance = credits.available_balance ?? credits.balance;
      if (availableBalance >= credits.minimum_generation_balance) return true;
      useAppStore.getState().pushNotification(
        tRef.current("platform_credits_preflight_low_balance", {
          balance: availableBalance.toLocaleString(),
          minimum: credits.minimum_generation_balance.toLocaleString(),
        }),
        "error",
      );
      return false;
    } catch {
      return true;
    }
  }, [projectData?.billing_mode]);

  const handleGenerateEpisodeProduction = useCallback(async (episode: EpisodeMeta) => {
    if (!projectData || generatingProductionEpisode !== null) return;

    const episodePath = `/episodes/${episode.episode}`;
    const mode = effectiveMode(projectData, episode);
    if (mode === "reference_video") {
      const busyUnitIds = new Set(
        tasks
          .filter(
            (task) =>
              task.project_name === projectName &&
              task.task_type === "reference_video" &&
              (task.status === "queued" || task.status === "running"),
          )
          .map((task) => task.resource_id),
      );
      setGeneratingProductionEpisode(episode.episode);
      try {
        const { units } = await API.listReferenceVideoUnits(projectName, episode.episode);
        const rawMissingUnits = units.filter((unit) => !unit.generated_assets.video_clip);
        const missingUnits = rawMissingUnits.filter((unit) => !busyUnitIds.has(unit.unit_id));
        if (missingUnits.length === 0) {
          useAppStore
            .getState()
            .pushToast(
              tRef.current(
                rawMissingUnits.length > 0
                  ? "reference_generate_batch_already_active"
                  : "reference_generate_batch_no_missing",
              ),
              "warning",
            );
          setLocation(episodePath);
          return;
        }
        const maxDuration = missingUnits.reduce(
          (max, unit) => Math.max(max, Number(unit.duration_seconds) || 0),
          0,
        );
        await runWithGenerationPreflight(
          {
            projectName,
            taskType: "reference_video",
            resourceId: `episode-${episode.episode}-reference-videos`,
            targetLabel: tRef.current("reference_generate_batch_button", { count: missingUnits.length }),
            payload: maxDuration > 0 ? { duration_seconds: maxDuration } : {},
            count: missingUnits.length,
          },
          async () => {
            if (!(await ensureGenerationCredits())) return;
            setGeneratingProductionEpisode(episode.episode);
            try {
              const results = await Promise.allSettled(
                missingUnits.map((unit) =>
                  API.generateReferenceVideoUnit(projectName, episode.episode, unit.unit_id),
                ),
              );
              const submitted = results.filter((result) => result.status === "fulfilled").length;
              const failed = results.length - submitted;
              if (submitted > 0) {
                useAppStore
                  .getState()
                  .pushToast(tRef.current("reference_generate_batch_submitted", { count: submitted }), "info");
              }
              if (failed > 0) {
                const reason = firstRejectedReason(results);
                const message = errMsg(reason);
                const text = isInsufficientCreditsError(reason)
                  ? tRef.current("platform_credits_insufficient_generation", { message })
                  : tRef.current("reference_generate_batch_failed", { count: failed, error: message });
                useAppStore.getState().pushNotification(text, "error");
              }
              setLocation(episodePath);
            } catch (err) {
              const message = errMsg(err);
              const text = isInsufficientCreditsError(err)
                ? tRef.current("platform_credits_insufficient_generation", { message })
                : tRef.current("reference_generate_request_failed", { error: message });
              useAppStore.getState().pushNotification(text, "error");
            } finally {
              setGeneratingProductionEpisode(null);
            }
          },
        );
      } catch (err) {
        const message = errMsg(err);
        const text = isInsufficientCreditsError(err)
          ? tRef.current("platform_credits_insufficient_generation", { message })
          : tRef.current("reference_generate_request_failed", { error: message });
        useAppStore.getState().pushNotification(text, "error");
      } finally {
        setGeneratingProductionEpisode(null);
      }
      return;
    }

    const scriptFile = normalizeScriptFileKey(episode.script_file);
    if (!scriptFile) {
      setLocation(episodePath);
      return;
    }

    let script = getScriptByFileKey(currentScripts, scriptFile);
    if (!script) {
      try {
        const res = await API.getProject(projectName);
        useProjectsStore.getState().setCurrentProject(
          projectName,
          res.project,
          res.scripts ?? {},
          res.asset_fingerprints,
        );
        script = getScriptByFileKey(res.scripts ?? {}, scriptFile);
      } catch {
        // Fall through to opening the episode; the page can surface the missing script state.
      }
    }

    if (!script) {
      setLocation(episodePath);
      return;
    }

    const items = getScriptGenerationItems(script);
    const activeStoryboardIds = getActiveGenerationResourceIds(tasks, projectName, "storyboard", scriptFile);
    const activeVideoIds = getActiveGenerationResourceIds(tasks, projectName, "video", scriptFile);
    const activeGridIds = getActiveGenerationResourceIds(tasks, projectName, "grid", scriptFile);
    const rawMissingStoryboardItems = items.filter((item) => !item.hasStoryboard);
    const rawReadyVideoItems = items.filter((item) => item.hasStoryboard && !item.hasVideo);
    if (mode === "grid" && rawMissingStoryboardItems.length > 0 && activeGridIds.size > 0) {
      useAppStore.getState().pushToast(tRef.current("grid_batch_already_active"), "warning");
      setLocation(episodePath);
      return;
    }
    const missingStoryboardItems = rawMissingStoryboardItems.filter(
      (item) => !item.hasStoryboard && !activeStoryboardIds.has(item.id),
    );
    const readyVideoItems = rawReadyVideoItems.filter(
      (item) => item.hasStoryboard && !item.hasVideo && !activeVideoIds.has(item.id),
    );
    const batchKind =
      missingStoryboardItems.length > 0
        ? mode === "grid" ? "grid" : "storyboard"
        : readyVideoItems.length > 0
          ? "video"
          : null;

    if (!batchKind) {
      if (rawMissingStoryboardItems.length > 0 || rawReadyVideoItems.length > 0) {
        useAppStore
          .getState()
          .pushToast(
            tRef.current(
              rawMissingStoryboardItems.length > 0
                ? mode === "grid" ? "grid_batch_already_active" : "storyboard_batch_already_active"
                : "video_batch_already_active",
            ),
            "warning",
          );
      }
      setLocation(episodePath);
      return;
    }
    const maxReadyVideoDuration = readyVideoItems.reduce(
      (max, item) => Math.max(max, Number(item.duration) || 0),
      0,
    );
    const preflightConfig =
      batchKind === "grid"
        ? {
          projectName,
          taskType: "grid" as const,
          resourceId: `episode-${episode.episode}-grids`,
          targetLabel: tRef.current("generate_all_grids"),
          payload: { script_file: scriptFile },
          count: Math.max(1, Math.ceil(missingStoryboardItems.length / 9)),
        }
        : batchKind === "storyboard"
          ? {
            projectName,
            taskType: "storyboard" as const,
            resourceId: `episode-${episode.episode}-storyboards`,
            targetLabel: tRef.current("generate_missing_storyboards", { count: missingStoryboardItems.length }),
            payload: { script_file: scriptFile },
            count: missingStoryboardItems.length,
          }
          : {
            projectName,
            taskType: "video" as const,
            resourceId: `episode-${episode.episode}-videos`,
            targetLabel: tRef.current("generate_missing_videos", { count: readyVideoItems.length }),
            payload: {
              script_file: scriptFile,
              ...(maxReadyVideoDuration > 0 ? { duration_seconds: maxReadyVideoDuration } : {}),
            },
            count: readyVideoItems.length,
          };

    await runWithGenerationPreflight(preflightConfig, async () => {
      if (!(await ensureGenerationCredits())) return;

      setGeneratingProductionEpisode(episode.episode);
      try {
        if (batchKind === "grid") {
          const result = await API.generateGrid(projectName, episode.episode, scriptFile);
          useAppStore.getState().pushToast(result.message, "success");
        } else {
          const batchItems = batchKind === "storyboard" ? missingStoryboardItems : readyVideoItems;
          const results = await Promise.allSettled(
            batchKind === "storyboard"
              ? batchItems.map((item) =>
                API.generateStoryboard(
                  projectName,
                  item.id,
                  item.imagePrompt as string | Record<string, unknown>,
                  scriptFile,
                ),
              )
              : batchItems.map((item) =>
                API.generateVideo(
                  projectName,
                  item.id,
                  item.videoPrompt as string | Record<string, unknown>,
                  scriptFile,
                  item.duration,
                ),
              ),
          );
          const submitted = results.filter((result) => result.status === "fulfilled").length;
          const failed = results.length - submitted;
          if (submitted > 0) {
            useAppStore.getState().pushToast(
              tRef.current(
                batchKind === "storyboard"
                  ? "storyboard_batch_submitted_toast"
                  : "video_batch_submitted_toast",
                { count: submitted },
              ),
              "success",
            );
          }
          if (failed > 0) {
            const reason = firstRejectedReason(results);
            const message = errMsg(reason);
            const text = isInsufficientCreditsError(reason)
              ? tRef.current("platform_credits_insufficient_generation", { message })
              : tRef.current(
                batchKind === "storyboard" ? "storyboard_batch_failed" : "video_batch_failed",
                { count: failed, message },
              );
            useAppStore.getState().pushNotification(text, "error");
          }
        }
        setLocation(episodePath);
      } catch (err) {
        const message = errMsg(err);
        const text = isInsufficientCreditsError(err)
          ? tRef.current("platform_credits_insufficient_generation", { message })
          : tRef.current("grid_generation_failed", { message });
        useAppStore.getState().pushNotification(text, "error");
      } finally {
        setGeneratingProductionEpisode(null);
      }
    });
  }, [
    currentScripts,
    ensureGenerationCredits,
    generatingProductionEpisode,
    projectData,
    projectName,
    runWithGenerationPreflight,
    setLocation,
    tasks,
  ]);

  const projectDeliverySummary = useMemo(
    () =>
      projectData
        ? buildProjectDeliverySummary(projectData, currentScripts, tasks, projectName)
        : null,
    [currentScripts, projectData, projectName, tasks],
  );
  const appliedTravelReferenceScenes = useMemo(
    () => getAppliedTravelReferenceScenes(projectData),
    [projectData],
  );
  const backendExportIssueEpisode = firstDeliveryReportIssueEpisode(backendExportPrompt?.deliveryReport);
  const previewReportIssueEpisode = firstDeliveryReportIssueEpisode(deliveryReportPreview?.deliveryReport);

  const startPreparedExport = useCallback((
    prepared: PreparedProjectExport,
    options: { showDiagnosticsAfterDownload?: boolean } = {},
  ) => {
    const showDiagnosticsAfterDownload = options.showDiagnosticsAfterDownload ?? true;
    triggerPreparedProjectDownload(projectName, prepared);
    const alertCount = countProjectExportAlerts(prepared);
    if (alertCount > 0) {
      if (showDiagnosticsAfterDownload) {
        setExportResult(prepared);
      }
      useAppStore
        .getState()
        .pushToast(
          tRef.current("project_zip_download_started_with_diagnostics", { count: alertCount }),
          "warning",
        );
    } else {
      useAppStore.getState().pushToast(tRef.current("project_zip_download_started"), "success");
    }
  }, [projectName]);

  const performExportProject = useCallback(async (options: { skipBackendGate?: boolean } = {}) => {
    if (exportingProject) return;
    setExportingProject(true);
    try {
      const prepared = await prepareProjectExport(projectName, "current");
      if (!options.skipBackendGate && shouldShowProjectExportPreflightDialog(prepared)) {
        setBackendExportPrompt(prepared);
        return;
      }
      startPreparedExport(prepared);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("export_failed", { message: errMsg(err) }), "error");
    } finally {
      setExportingProject(false);
    }
  }, [exportingProject, projectName, startPreparedExport]);

  const handleExportProject = useCallback(async (force = false) => {
    if (!force && projectDeliverySummary && hasProjectExportGateIssues(projectDeliverySummary)) {
      setPreExportPrompt(projectDeliverySummary);
      return;
    }

    setPreExportPrompt(null);
    await performExportProject({ skipBackendGate: force });
  }, [performExportProject, projectDeliverySummary]);

  const handleOpenDeliveryReport = useCallback(async () => {
    if (deliveryReportLoading) return;
    setDeliveryReportLoading(true);
    try {
      const prepared = await loadProjectExportPreflight(projectName, "current");
      setDeliveryReportPreview(prepared);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("delivery_report_load_failed", { message: errMsg(err) }), "error");
    } finally {
      setDeliveryReportLoading(false);
    }
  }, [deliveryReportLoading, projectName]);

  const handleOpenModelRuleAudit = useCallback(async () => {
    if (modelRuleAuditLoading) return;
    setModelRuleAuditLoading(true);
    try {
      const prepared = await loadProjectExportPreflight(projectName, "current");
      if (!prepared.modelRuleAudit) {
        useAppStore
          .getState()
          .pushNotification(tRef.current("model_rule_audit_preview_load_empty"), "warning");
        return;
      }
      setModelRuleAuditPreview(prepared.modelRuleAudit);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("model_rule_audit_preview_load_failed", { message: errMsg(err) }), "error");
    } finally {
      setModelRuleAuditLoading(false);
    }
  }, [modelRuleAuditLoading, projectName]);

  const handleOpenTravelRouteAssetPreview = useCallback(async () => {
    if (travelRouteAssetLoading) return;
    setTravelRouteAssetLoading(true);
    try {
      const prepared = await loadProjectExportPreflight(projectName, "current");
      if (!prepared.travelRouteAssets) {
        useAppStore
          .getState()
          .pushNotification(tRef.current("travel_route_asset_preview_empty"), "warning");
        return;
      }
      setTravelRouteAssetPreview(prepared);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("delivery_report_load_failed", { message: errMsg(err) }), "error");
    } finally {
      setTravelRouteAssetLoading(false);
    }
  }, [projectName, travelRouteAssetLoading]);

  useEffect(() => {
    if (autoOpenedTravelRouteAssetsRef.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("openTravelRouteAssets") !== "1") return;

    autoOpenedTravelRouteAssetsRef.current = true;
    params.delete("openTravelRouteAssets");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
    void handleOpenTravelRouteAssetPreview();
  }, [handleOpenTravelRouteAssetPreview]);

  const handleWorkflowStageAction = useCallback(async (stage: ProjectWorkflowStage) => {
    if (!projectData) return;
    if (stage.state !== "current") {
      setLocation(stage.actionPath);
      return;
    }

    if (stage.key === "setup") {
      if (projectData.overview) {
        setLocation(stage.actionPath);
      } else {
        await handleRegenerate();
      }
      return;
    }

    if (stage.key === "worldbuilding") {
      await handlePrepareAssets("full");
      return;
    }

    if (stage.key === "scripting") {
      const episodes = projectData.episodes ?? [];
      if (episodes.length === 0) {
        await handleGenerateFirstEpisodeDraft();
        return;
      }

      const target = episodes.find((ep) => ep.script_status !== "generated") ?? episodes[0];
      if (target?.script_status === "segmented") {
        await handleGenerateEpisodeScript(target.episode);
        return;
      }

      setLocation(stage.actionPath);
      return;
    }

    if (stage.key === "production") {
      const episodes = projectData.episodes ?? [];
      const target = episodes.find((ep) => ep.status !== "completed") ?? episodes[0];
      if (target) {
        await handleGenerateEpisodeProduction(target);
      } else {
        setLocation(stage.actionPath);
      }
      return;
    }

    if (stage.key === "completed") {
      await handleExportProject();
      return;
    }

    setLocation(stage.actionPath);
  }, [
    handleGenerateEpisodeScript,
    handleGenerateFirstEpisodeDraft,
    handleGenerateEpisodeProduction,
    handleExportProject,
    handlePrepareAssets,
    handleRegenerate,
    projectData,
    setLocation,
  ]);

  const handleRetryDeliveryEpisode = useCallback(async (check: ProjectDeliveryEpisodeCheck) => {
    if (retryingDeliveryEpisode !== null) return;
    const failedTasks = tasks.filter((task) =>
      task.status === "failed" && isEpisodeTask(task, projectName, check.episode),
    );
    if (failedTasks.length === 0) {
      setLocation(`/episodes/${check.episode.episode}`);
      return;
    }

    setRetryingDeliveryEpisode(check.episode.episode);
    try {
      const results = await Promise.allSettled(
        failedTasks.map((task) => API.retryTask(task.task_id)),
      );
      const submitted = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - submitted;
      useAppStore.getState().pushToast(
        tRef.current("project_delivery_retry_submitted", { count: submitted }),
        failed > 0 ? "warning" : "success",
      );
      if (failed > 0) {
        const reason = firstRejectedReason(results);
        useAppStore.getState().pushNotification(
          tRef.current("project_delivery_retry_failed", { message: errMsg(reason) }),
          "error",
        );
      }
    } finally {
      setRetryingDeliveryEpisode(null);
    }
  }, [projectName, retryingDeliveryEpisode, setLocation, tasks]);

  const handleProjectDeliveryNext = useCallback(async () => {
    const next = projectDeliverySummary?.firstAction;
    if (!next) return;
    if (next.action === "retry_failed") {
      await handleRetryDeliveryEpisode(next);
      return;
    }
    if (next.action === "generate_script") {
      await handleGenerateEpisodeScript(next.episode.episode);
      return;
    }
    await handleGenerateEpisodeProduction(next.episode);
  }, [
    handleGenerateEpisodeProduction,
    handleGenerateEpisodeScript,
    handleRetryDeliveryEpisode,
    projectDeliverySummary?.firstAction,
  ]);

  if (!projectData) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        {t("loading_project_data")}
      </div>
    );
  }

  const status = projectData.status;
  const overview = projectData.overview;
  const showWelcome = !overview && (projectData.episodes?.length ?? 0) === 0;
  const focusRing = "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900";
  const preparingAssets = assetPrepMode !== null;
  const workflowCurrentPhase = getProjectWorkflowCurrentPhase(projectData);
  const workflowNextStage = getProjectWorkflowNextStage(projectData);
  const workflowNextBusy =
    checkingGenerationPreflight ||
    guidedWorkflowRunning ||
    regenerating ||
    preparingAssets ||
    generatingEpisodeDraft !== null ||
    generatingEpisodeScript !== null ||
    generatingProductionEpisode !== null ||
    retryingDeliveryEpisode !== null ||
    exportingProject;
  const contentTypePreset = getContentTypePreset(projectData.content_type);
  const effectiveContentMode = contentTypePreset?.contentMode ?? projectData.content_mode;
  const nextEpisodeNumber =
    (projectData.episodes ?? []).reduce((max, ep) => Math.max(max, ep.episode), 0) + 1;
  const effectiveAspectRatio =
    typeof projectData.aspect_ratio === "string"
      ? projectData.aspect_ratio
      : contentTypePreset?.aspectRatio;
  const aspectRatioLabel = effectiveAspectRatio === "9:16"
    ? t("portrait_9_16")
    : t("landscape_16_9");
  const contentModeLabel = contentTypePreset?.contentMode === "narration"
    ? t("narration_visuals")
    : t("drama_animation");
  const generationModeLabel = contentTypePreset
    ? t(`mode_${contentTypePreset.generationMode}`)
    : "";
  const handleRetryQuickStartStep = (step: QuickStartStepKey) => {
    void handleRunGuidedWorkflowWithPreflight(step);
  };
  const handleRetryOverviewAction = (retry: OverviewActionRetry) => {
    if (retry.kind === "asset_prepare") {
      void handlePrepareAssets(retry.mode);
      return;
    }
    void handleRunGuidedWorkflowWithPreflight(retry.startFrom);
  };
  const openTravelVideoSettings = () => {
    setLocation(`~/app/projects/${encodeURIComponent(projectName)}/settings`);
  };
  const quickStartProgress = (
    <QuickStartProgressPanel
      steps={quickStartSteps}
      stepDefinitions={quickStartPlan.steps}
      running={guidedWorkflowRunning}
      onRetry={handleRetryQuickStartStep}
    />
  );

  return (
    <>
      <div className="h-full overflow-y-auto">
        <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">{projectData.title}</h1>
          <p className="mt-1 text-sm text-gray-400">
            {effectiveContentMode === "narration"
              ? t("narration_visuals_mode")
              : t("drama_animation_mode")}
          </p>
        </div>

        <TravelVideoRoutePreviewPanel
          projectName={projectName}
          projectData={projectData}
          aspectRatioLabel={aspectRatioLabel}
          onOpenSettings={openTravelVideoSettings}
          onOpenAssetManifest={() => void handleOpenTravelRouteAssetPreview()}
          assetManifestLoading={travelRouteAssetLoading}
        />

        {showWelcome ? (
          <WelcomeCanvas
            projectName={projectName}
            projectTitle={projectData.title}
            onUpload={handleUpload}
            onAnalyze={handleAnalyze}
            quickStartActive={workflowGuideActive}
            quickStartRunning={guidedWorkflowRunning}
            quickStartProgress={quickStartProgress}
            onQuickStart={handleRunGuidedWorkflowWithPreflight}
            onDismissQuickStart={dismissWorkflowGuide}
          />
        ) : (
          <>
            {workflowGuideActive && (
              <section className="rounded-xl border border-indigo-400/25 bg-indigo-500/10 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-indigo-100">{t("workflow_quickstart_title")}</p>
                    <p className="mt-1 max-w-3xl text-sm leading-6 text-indigo-100/75">
                      {t("workflow_quickstart_desc")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleRunGuidedWorkflowWithPreflight()}
                      disabled={workflowNextBusy}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
                    >
                      {guidedWorkflowRunning ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <WandSparkles className="h-4 w-4" />
                      )}
                      {guidedWorkflowRunning ? t("workflow_quickstart_running") : t("workflow_quickstart_button")}
                    </button>
                    <button
                      type="button"
                      onClick={dismissWorkflowGuide}
                      className={`rounded-lg p-2 text-indigo-100/60 transition-colors hover:bg-indigo-500/15 hover:text-indigo-50 ${focusRing}`}
                      aria-label={t("workflow_quickstart_dismiss")}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-3">{quickStartProgress}</div>
              </section>
            )}
            {contentTypePreset && (
              <section className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-indigo-300">
                      {t("content_workflow_title")}
                    </p>
                    <h3 className="mt-1 text-base font-semibold text-gray-100">
                      {t("content_workflow_heading", { type: t(contentTypePreset.labelKey) })}
                    </h3>
                    <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-400">
                      {t(contentTypePreset.workflowGoalKey)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-300">
                      {contentModeLabel}
                    </span>
                    <span className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-300">
                      {aspectRatioLabel}
                    </span>
                    <span className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-300">
                      {generationModeLabel}
                    </span>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  {contentTypePreset.workflowRuleKeys.map((ruleKey, index) => (
                    <div
                      key={ruleKey}
                      className="rounded-lg border border-gray-800 bg-gray-950/50 p-3"
                    >
                      <span className="text-[11px] text-indigo-300">
                        {t("content_workflow_rule_prefix", { index: index + 1 })}
                      </span>
                      <p className="mt-1 text-sm leading-5 text-gray-300">{t(ruleKey)}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {overview && (
              <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-300">{t("project_overview_title")}</h3>
                  <button
                    type="button"
                    onClick={() => void handleRegenerate()}
                    disabled={regenerating}
                    className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
                    title={t("regen_overview_title")}
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${regenerating ? "animate-spin" : ""}`}
                    />
                    <span>{regenerating ? t("regenerating_short") : t("regen_short")}</span>
                  </button>
                </div>
                <p className="text-sm text-gray-400">{overview.synopsis}</p>
                <div className="flex gap-4 text-xs text-gray-500">
                  <span>{t("genre_prefix")}{overview.genre}</span>
                  <span>{t("theme_prefix")}{overview.theme}</span>
                </div>
              </div>
            )}

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-300">{t("workflow_panel_title")}</h3>
                  <p className="mt-1 text-xs text-gray-500">{t("workflow_panel_desc")}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void handleRunGuidedWorkflowWithPreflight()}
                    disabled={workflowNextBusy}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 ${focusRing}`}
                  >
                    {guidedWorkflowRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <WandSparkles className="h-3.5 w-3.5" />
                    )}
                    {guidedWorkflowRunning ? t("workflow_quickstart_running") : t("workflow_quickstart_button")}
                  </button>
                  <button
                    type="button"
                    onClick={() => workflowNextStage && void handleWorkflowStageAction(workflowNextStage)}
                    disabled={!workflowNextStage || workflowNextBusy}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 ${focusRing}`}
                    title={
                      workflowNextStage
                        ? t("workflow_next_tooltip", { phase: t(`workflow_stage_${workflowNextStage.key}`) })
                        : undefined
                    }
                  >
                    {workflowNextBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5" />
                    )}
                    {workflowNextStage
                      ? t("workflow_next_action_with_label", {
                        label: t(workflowNextStage.actionLabelKey),
                      })
                      : t("workflow_next_action")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handlePrepareAssets("lists")}
                    disabled={preparingAssets}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 ${focusRing}`}
                  >
                    {assetPrepMode === "lists" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <WandSparkles className="h-3.5 w-3.5" />
                    )}
                    {assetPrepMode === "lists" ? t("asset_prepare_lists_running") : t("asset_prepare_lists_button")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handlePrepareAssets("full")}
                    disabled={preparingAssets}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 ${focusRing}`}
                  >
                    {assetPrepMode === "full" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <WandSparkles className="h-3.5 w-3.5" />
                    )}
                    {assetPrepMode === "full" ? t("asset_prepare_running") : t("asset_prepare_button")}
                  </button>
                  <span className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-100">
                    {t(`workflow_phase_${workflowCurrentPhase}`)}
                  </span>
                </div>
              </div>
              {overviewActionFeedback && (
                <OverviewActionFeedbackPanel
                  feedback={overviewActionFeedback}
                  busy={workflowNextBusy}
                  onRetry={handleRetryOverviewAction}
                />
              )}
              <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
                {getProjectWorkflowStages(projectData).map((stage, index) => {
                  const Icon = stage.state === "done" ? CheckCircle2 : stage.state === "current" ? PlayCircle : Circle;
                  const stageActionBusy = stage.state === "current" && workflowNextBusy;
                  return (
                    <div
                      key={stage.key}
                      className="grid gap-3 border-b border-gray-800 px-4 py-3 last:border-b-0 md:grid-cols-[2rem_minmax(0,1fr)_8rem_auto]"
                    >
                      <div className="flex items-start gap-2 md:block">
                        <Icon
                          className={`h-5 w-5 ${
                            stage.state === "done"
                              ? "text-emerald-300"
                              : stage.state === "current"
                                ? "text-indigo-300"
                                : "text-gray-600"
                          }`}
                        />
                        <span className="text-xs text-gray-600 md:hidden">{index + 1}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-gray-100">
                            {t(`workflow_stage_${stage.key}`)}
                          </span>
                          <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500">
                            {index + 1}/{WORKFLOW_PHASES.length}
                          </span>
                        </div>
                        <p className="mt-1 text-sm leading-5 text-gray-500">
                          {t(stage.descriptionKey, stage.descriptionParams)}
                        </p>
                        {stage.actionDetailKey && (
                          <p className="mt-1 text-xs leading-5 text-indigo-200/70">
                            {t(stage.actionDetailKey, stage.actionDetailParams)}
                          </p>
                        )}
                      </div>
                      <div className="min-w-0 md:self-center">
                        <div className="mb-1 flex justify-between text-xs text-gray-500">
                          <span>{t("workflow_stage_progress")}</span>
                          <span>{stage.progress}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-gray-800">
                          <div
                            className={`h-full rounded-full ${
                              stage.state === "done" ? "bg-emerald-400" : "bg-indigo-500"
                            }`}
                            style={{ width: `${stage.progress}%` }}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleWorkflowStageAction(stage)}
                        disabled={stageActionBusy}
                        className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 md:self-center ${
                          stage.state === "current"
                            ? "border-indigo-400/40 bg-indigo-500/10 text-indigo-100 hover:bg-indigo-500/15"
                            : "border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
                        }`}
                      >
                        {t(stage.actionLabelKey)}
                        {stageActionBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ArrowRight className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {projectDeliverySummary && projectDeliverySummary.totalEpisodes > 0 && (
              <ProjectDeliverySummaryPanel
                summary={projectDeliverySummary}
                busy={workflowNextBusy}
                exporting={exportingProject}
                retrying={retryingDeliveryEpisode !== null}
                reporting={deliveryReportLoading}
                auditing={modelRuleAuditLoading}
                onHandleNext={() => void handleProjectDeliveryNext()}
                onExport={() => void handleExportProject()}
                onOpenReport={() => void handleOpenDeliveryReport()}
                onOpenModelRuleAudit={() => void handleOpenModelRuleAudit()}
                onOpenEpisode={(episode) => setLocation(`/episodes/${episode}`)}
              />
            )}

            {status && (
              <div className="grid grid-cols-2 gap-3">
                {(["characters", "scenes", "props"] as const).map(
                  (key) => {
                    const cat = status[key] as
                      | { total: number; completed: number }
                      | undefined;
                    if (!cat) return null;
                    const pct =
                      cat.total > 0
                        ? Math.round((cat.completed / cat.total) * 100)
                        : 0;
                    const labels: Record<string, string> = {
                      characters: t("characters"),
                      scenes: t("scenes"),
                      props: t("props"),
                    };
                    return (
                      <div
                        key={key}
                        className="rounded-lg border border-gray-800 bg-gray-900 p-3"
                      >
                        <div className="mb-1 flex justify-between text-xs">
                          <span className="text-gray-400">{labels[key]}</span>
                          <span className="text-gray-300">
                            {cat.completed}/{cat.total}
                          </span>
                        </div>
                        <div
                          className="h-1.5 overflow-hidden rounded-full bg-gray-800"
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className="h-full rounded-full bg-indigo-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            )}

            {costLoading && (
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                <p className="text-sm text-gray-500 animate-pulse">{t("calculating_cost")}</p>
              </div>
            )}
            {costError && (
              <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4">
                <p className="text-sm text-red-400">{t("cost_estimate_failed", { message: costError })}</p>
              </div>
            )}

            {projectTotals && (
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 tabular-nums">
                <p className="mb-3 text-sm font-semibold text-gray-300">{t("project_total_cost")}</p>
                <dl className="flex flex-wrap items-start justify-between gap-6">
                  <div className="min-w-0">
                    <dt className="mb-1 text-[11px] text-gray-600">{t("estimate")}</dt>
                    <dd className="text-sm text-gray-400">
                      <span className="text-gray-500">{t("storyboard")} </span>
                      <span className="text-gray-200">{formatCost(projectTotals.estimate.image)}</span>
                      <span className="ml-3 text-gray-500">{t("video")} </span>
                      <span className="text-gray-200">{formatCost(projectTotals.estimate.video)}</span>
                      <span className="ml-3 text-gray-500">{t("total")} </span>
                      <span className="font-semibold text-amber-400">{formatCost(totalBreakdown(projectTotals.estimate))}</span>
                    </dd>
                  </div>
                  <div role="separator" className="h-8 w-px bg-gray-800" />
                  <div className="min-w-0">
                    <dt className="mb-1 text-[11px] text-gray-600">{t("actual")}</dt>
                    <dd className="text-sm text-gray-400">
                      <span className="text-gray-500">{t("storyboard")} </span>
                      <span className="text-gray-200">{formatCost(projectTotals.actual.image)}</span>
                      <span className="ml-3 text-gray-500">{t("video")} </span>
                      <span className="text-gray-200">{formatCost(projectTotals.actual.video)}</span>
                      {(["characters", "scenes", "props"] as const).map((kind) => {
                        const bucket = projectTotals.actual[kind];
                        if (!bucket) return null;
                        return (
                          <span key={kind} className="ml-3">
                            <span className="text-gray-500">{t(`actual_${kind}`)} </span>
                            <span className="text-gray-200">{formatCost(bucket)}</span>
                          </span>
                        );
                      })}
                      <span className="ml-3 text-gray-500">{t("total")} </span>
                      <span className="font-semibold text-emerald-400">{formatCost(totalBreakdown(projectTotals.actual))}</span>
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-gray-300">{t("episodes_title")}</h3>
                {(projectData.episodes?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleGenerateEpisodeDraft(nextEpisodeNumber)}
                    disabled={generatingEpisodeDraft !== null}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 ${focusRing}`}
                  >
                    {generatingEpisodeDraft === nextEpisodeNumber ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <WandSparkles className="h-3.5 w-3.5" />
                    )}
                    {generatingEpisodeDraft === nextEpisodeNumber
                      ? t("episode_draft_generating")
                      : t("generate_next_episode_draft", { episode: nextEpisodeNumber })}
                  </button>
                )}
              </div>
              {(projectData.episodes?.length ?? 0) === 0 ? (
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-gray-500">
                      {t("no_episodes_ai_hint")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleGenerateFirstEpisodeDraft()}
                      disabled={generatingEpisodeDraft !== null}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 ${focusRing}`}
                    >
                      {generatingEpisodeDraft === 1 ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <WandSparkles className="h-4 w-4" />
                      )}
                      {generatingEpisodeDraft === 1 ? t("episode_draft_generating") : t("generate_first_episode_draft")}
                    </button>
                  </div>
                </div>
              ) : (
                (projectData.episodes ?? []).map((ep) => {
                  const epCost = getEpisodeCost(ep.episode);
                  return (
                    <button
                      key={ep.episode}
                      type="button"
                      onClick={() => setLocation(`/episodes/${ep.episode}`)}
                      aria-label={t("open_episode_aria", { episode: ep.episode, title: ep.title })}
                      className="group flex w-full flex-wrap items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2.5 text-left tabular-nums transition-colors hover:border-gray-700 hover:bg-gray-800/80 focus-ring"
                    >
                      <span className="font-mono text-xs text-gray-400">
                        E{ep.episode}
                      </span>
                      <span className="text-sm text-gray-200">{ep.title}</span>
                      <span className="text-xs text-gray-500">
                        {t("segments_and_status", { count: ep.scenes_count ?? "?", status: ep.status ?? "draft" })}
                      </span>
                      <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-200">
                        {t(episodeNextActionKey(ep))}
                      </span>
                      {epCost && (
                        <span className="ml-auto flex min-w-0 flex-shrink flex-wrap gap-4 text-xs text-gray-400">
                          <span>
                            <span className="text-gray-500">{t("estimate")} </span>
                            <span className="text-gray-500">{t("storyboard")} </span><span className="text-gray-300">{formatCost(epCost.totals.estimate.image)}</span>
                            <span className="ml-2 text-gray-500">{t("video")} </span><span className="text-gray-300">{formatCost(epCost.totals.estimate.video)}</span>
                            <span className="ml-2 text-gray-500">{t("total")} </span><span className="font-medium text-amber-400">{formatCost(totalBreakdown(epCost.totals.estimate))}</span>
                          </span>
                          <span className="text-gray-700">|</span>
                          <span>
                            <span className="text-gray-500">{t("actual")} </span>
                            <span className="text-gray-500">{t("storyboard")} </span><span className="text-gray-300">{formatCost(epCost.totals.actual.image)}</span>
                            <span className="ml-2 text-gray-500">{t("video")} </span><span className="text-gray-300">{formatCost(epCost.totals.actual.video)}</span>
                            <span className="ml-2 text-gray-500">{t("total")} </span><span className="font-medium text-emerald-400">{formatCost(totalBreakdown(epCost.totals.actual))}</span>
                          </span>
                        </span>
                      )}
                      <ArrowRight className="h-4 w-4 text-gray-600 transition-colors group-hover:text-gray-300" />
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}

        <div className="h-8" />
        </div>
        {conflictPrompt && (
        <ConflictModal
          existing={conflictPrompt.existing}
          suggestedName={conflictPrompt.suggestedName}
          onResolve={conflictPrompt.resolve}
        />
      )}
      </div>
      {exportResult !== null && (
        <ArchiveDiagnosticsDialog
          title={t("export_diagnostics_title")}
          description={t("export_diagnostics_description")}
          sections={[
            { key: "blocking", title: t("diagnostics_blocking"), tone: "border-red-400/25 bg-red-500/10 text-red-100", items: exportResult.diagnostics.blocking },
            { key: "auto_fixed", title: t("diagnostics_auto_fixed"), tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: exportResult.diagnostics.auto_fixed },
            { key: "warnings", title: t("diagnostics_warnings"), tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: exportResult.diagnostics.warnings },
          ]}
          deliveryReport={exportResult.deliveryReport}
          modelRuleAudit={exportResult.modelRuleAudit}
          deliveryReportFilePrefix={projectName}
          onClose={() => setExportResult(null)}
          onOpenTask={(taskId) => {
            setExportResult(null);
            useAppStore.getState().triggerTaskHudFocus(taskId);
          }}
        />
      )}
      {backendExportPrompt !== null && (
        <ArchiveDiagnosticsDialog
          title={t("export_preflight_title")}
          description={countProjectExportPreflightIssues(backendExportPrompt) > 0
            ? t("export_preflight_description")
            : t("project_export_gate_desc_route_assets")}
          sections={[
            { key: "blocking", title: t("diagnostics_blocking"), tone: "border-red-400/25 bg-red-500/10 text-red-100", items: backendExportPrompt.diagnostics.blocking },
            { key: "auto_fixed", title: t("diagnostics_auto_fixed"), tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: backendExportPrompt.diagnostics.auto_fixed },
            { key: "warnings", title: t("diagnostics_warnings"), tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: backendExportPrompt.diagnostics.warnings },
          ]}
          deliveryReport={backendExportPrompt.deliveryReport}
          modelRuleAudit={backendExportPrompt.modelRuleAudit}
          deliveryReportFilePrefix={projectName}
          showCleanDeliveryReport={hasTravelRouteAssetManifest(backendExportPrompt)}
          confirmLabel={countProjectExportPreflightIssues(backendExportPrompt) > 0
            ? t("project_export_gate_force_export")
            : t("project_export_gate_confirm_export")}
          secondaryLabel={backendExportIssueEpisode !== null ? t("project_export_gate_go_fix") : undefined}
          onClose={() => setBackendExportPrompt(null)}
          onOpenTask={(taskId) => {
            setBackendExportPrompt(null);
            useAppStore.getState().triggerTaskHudFocus(taskId);
          }}
          onSecondary={backendExportIssueEpisode !== null
            ? () => {
              const episode = backendExportIssueEpisode;
              setBackendExportPrompt(null);
              setLocation(`/episodes/${episode}`);
            }
            : undefined}
          onConfirm={() => {
            const prepared = backendExportPrompt;
            setBackendExportPrompt(null);
            startPreparedExport(prepared, { showDiagnosticsAfterDownload: false });
          }}
        />
      )}
      {deliveryReportPreview !== null && (
        <ArchiveDiagnosticsDialog
          title={t("delivery_report_preview_title")}
          description={t("delivery_report_preview_description")}
          sections={[
            { key: "blocking", title: t("diagnostics_blocking"), tone: "border-red-400/25 bg-red-500/10 text-red-100", items: deliveryReportPreview.diagnostics.blocking },
            { key: "warnings", title: t("diagnostics_warnings"), tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: deliveryReportPreview.diagnostics.warnings },
          ]}
          deliveryReport={deliveryReportPreview.deliveryReport}
          modelRuleAudit={deliveryReportPreview.modelRuleAudit}
          deliveryReportMode="all"
          deliveryReportFilePrefix={projectName}
          showCleanDeliveryReport
          onOpenTask={(taskId) => {
            setDeliveryReportPreview(null);
            useAppStore.getState().triggerTaskHudFocus(taskId);
          }}
          secondaryLabel={previewReportIssueEpisode !== null ? t("project_export_gate_go_fix") : undefined}
          onClose={() => setDeliveryReportPreview(null)}
          onSecondary={previewReportIssueEpisode !== null
            ? () => {
              const episode = previewReportIssueEpisode;
              setDeliveryReportPreview(null);
              setLocation(`/episodes/${episode}`);
            }
            : undefined}
        />
      )}
      {modelRuleAuditPreview !== null && (
        <ModelRuleAuditPreviewDialog
          manifest={modelRuleAuditPreview}
          onOpenRules={(ruleTarget) => {
            setModelRuleAuditPreview(null);
            const targetQuery = ruleTarget ? `&ruleTarget=${encodeURIComponent(ruleTarget)}` : "";
            setLocation(`/app/settings?section=media${targetQuery}`);
          }}
          onOpenTask={(taskId) => {
            setModelRuleAuditPreview(null);
            useAppStore.getState().triggerTaskHudFocus(taskId);
          }}
          onClose={() => setModelRuleAuditPreview(null)}
        />
      )}
      {travelRouteAssetPreview?.travelRouteAssets && (
        <TravelRouteAssetPreviewDialog
          projectName={projectName}
          manifest={travelRouteAssetPreview.travelRouteAssets}
          appliedReferenceScenes={appliedTravelReferenceScenes}
          onOpenUnit={({ episode, unitId }) => {
            setTravelRouteAssetPreview(null);
            setLocation(`/episodes/${episode}`);
            useAppStore.getState().triggerScrollTo({
              type: "reference-unit",
              id: unitId,
              route: `/episodes/${episode}`,
            });
          }}
          onFindReferenceAsset={(path) => {
            const searchTerm = getTravelReferenceSearchTerm(path);
            const params = new URLSearchParams({
              type: "scene",
              q: searchTerm,
              travelRef: path,
              targetProject: projectName,
            });
            rememberAssetLibraryReturnTo(window.location.pathname + window.location.search);
            setTravelRouteAssetPreview(null);
            setLocation(`~/app/assets?${params.toString()}`);
          }}
          onSaveReferenceAsset={async (path) => {
            const assetName = getTravelReferenceSearchTerm(path);
            try {
              const { asset } = await API.addAssetFromProjectFile({
                project_name: projectName,
                file_path: path,
                asset_type: "scene",
                name: assetName,
                description: t("travel_route_asset_library_description", { path }),
                conflict_policy: "rename",
              });
              const applyResult = await API.applyAssetsToProject({
                asset_ids: [asset.id],
                target_project: projectName,
                conflict_policy: "skip",
              });
              if (applyResult.failed.length > 0) {
                throw new Error(applyResult.failed[0]?.reason || t("travel_route_asset_library_apply_failed"));
              }
              await refreshProject();
              useAppStore.getState().pushToast(
                t("travel_route_asset_library_saved", { name: asset.name }),
                "success",
              );
              const params = new URLSearchParams({
                type: "scene",
                q: asset.name,
                travelRef: path,
                targetProject: projectName,
                focus: asset.id,
              });
              rememberAssetLibraryReturnTo(window.location.pathname + window.location.search);
              setTravelRouteAssetPreview(null);
              setLocation(`~/app/assets?${params.toString()}`);
            } catch (err) {
              useAppStore.getState().pushToast(errMsg(err), "error");
              throw err;
            }
          }}
          onSaveAllReferenceAssets={async (paths) => {
            const uniquePaths = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
            if (uniquePaths.length === 0) return { savedPaths: [], failed: 0 };
            const results = await Promise.allSettled(
              uniquePaths.map(async (path) => ({
                path,
                result: await API.addAssetFromProjectFile({
                  project_name: projectName,
                  file_path: path,
                  asset_type: "scene",
                  name: getTravelReferenceSearchTerm(path),
                  description: t("travel_route_asset_library_description", { path }),
                  conflict_policy: "rename",
                }),
              })),
            );
            const saved = results.filter((result) => result.status === "fulfilled").length;
            const failed = results.length - saved;
            const savedEntries = results.flatMap((result) =>
              result.status === "fulfilled" ? [result.value] : []
            );
            const savedAssets = savedEntries.map((entry) => entry.result.asset);
            let appliedPaths: string[] = [];
            let applyFailed = 0;
            if (savedAssets.length > 0) {
              try {
                const applyResult = await API.applyAssetsToProject({
                  asset_ids: savedAssets.map((asset) => asset.id),
                  target_project: projectName,
                  conflict_policy: "skip",
                });
                applyFailed = applyResult.failed.length;
                const appliedAssetIds = new Set([
                  ...applyResult.succeeded.map((asset) => asset.id),
                  ...applyResult.skipped.map((asset) => asset.id),
                ]);
                appliedPaths = savedEntries
                  .filter((entry) => appliedAssetIds.has(entry.result.asset.id))
                  .map((entry) => entry.path);
                if (applyFailed > 0) {
                  useAppStore.getState().pushNotification(
                    t("travel_route_asset_library_apply_batch_failed", {
                      count: applyFailed,
                      message: applyResult.failed[0]?.reason || t("travel_route_asset_library_apply_failed"),
                    }),
                    "error",
                  );
                }
                await refreshProject();
              } catch (err) {
                applyFailed = savedAssets.length;
                useAppStore.getState().pushNotification(
                  t("travel_route_asset_library_apply_batch_failed", {
                    count: savedAssets.length,
                    message: errMsg(err),
                  }),
                  "error",
                );
              }
            }
            if (saved > 0) {
              useAppStore.getState().pushToast(
                t("travel_route_asset_library_batch_saved", { count: saved }),
                failed > 0 || applyFailed > 0 ? "warning" : "success",
              );
            }
            if (failed > 0) {
              useAppStore.getState().pushNotification(
                t("travel_route_asset_library_batch_failed", {
                  count: failed,
                  message: errMsg(firstRejectedReason(results)),
                }),
                "error",
              );
            }
            if (saved === 0 && failed > 0) {
              throw firstRejectedReason(results);
            }
            const totalFailed = failed + applyFailed;
            if (appliedPaths.length === 0 && totalFailed > 0) {
              throw new Error(t("travel_route_asset_library_apply_failed"));
            }
            return { savedPaths: appliedPaths, failed: totalFailed };
          }}
          onClose={() => setTravelRouteAssetPreview(null)}
        />
      )}
      {generationPreflightDialog}
      {preExportPrompt !== null && (
        <ProjectPreExportDialog
          summary={preExportPrompt}
          busy={exportingProject || workflowNextBusy}
          onClose={() => setPreExportPrompt(null)}
          onHandleNext={() => {
            setPreExportPrompt(null);
            void handleProjectDeliveryNext();
          }}
          onConfirmExport={() => void handleExportProject(true)}
        />
      )}
    </>
  );
}
