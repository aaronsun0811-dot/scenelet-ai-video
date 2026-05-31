import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, CheckCircle2, Clapperboard, Download, ExternalLink, FileJson, Images, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { SegmentCard } from "./SegmentCard";
import { GridSegmentGroup } from "./GridSegmentGroup";
import { PreprocessingView } from "./PreprocessingView";
import { useGenerationPreflightGate } from "@/components/ui/GenerationPreflight";
import { AuthenticatedImage } from "@/components/ui/AuthenticatedMedia";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { useAppStore } from "@/stores/app-store";
import { useCostStore } from "@/stores/cost-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import { formatCost, totalBreakdown } from "@/utils/cost-format";
import { errMsg } from "@/utils/async";
import { API, type GenerationPreflightTaskType } from "@/api";
import { effectiveMode } from "@/utils/generation-mode";
import { getActiveGenerationResourceIds } from "@/utils/generation-tasks";
import { normalizeScriptFileKey } from "@/utils/script-generation";
import type { GridGeneration } from "@/types/grid";
import type {
  EpisodeScript,
  NarrationEpisodeScript,
  DramaEpisodeScript,
  NarrationSegment,
  DramaScene,
  ProjectData,
  TaskItem,
} from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Segment = NarrationSegment | DramaScene;
const GRID_IN_PROGRESS_STATUSES = new Set<GridGeneration["status"]>(["pending", "generating", "splitting"]);

function getSegmentId(segment: Segment, mode: "narration" | "drama"): string {
  return mode === "narration"
    ? (segment as NarrationSegment).segment_id
    : (segment as DramaScene).scene_id;
}

function getSegmentGenerationPrompt(segment: Segment, field: "image_prompt" | "video_prompt"): unknown {
  const value = (segment as unknown as Record<string, unknown>)[field];
  return value ?? "";
}

function toGenerationPreflightTaskType(value: string): GenerationPreflightTaskType | null {
  return ["storyboard", "video", "character", "scene", "prop", "grid", "reference_video", "workflow"].includes(value)
    ? (value as GenerationPreflightTaskType)
    : null;
}

function isGridInProgress(grid: GridGeneration): boolean {
  return GRID_IN_PROGRESS_STATUSES.has(grid.status);
}

function resolveTaskEpisode(task: TaskItem): number | null {
  const payloadScriptFile =
    typeof task.payload.script_file === "string" ? task.payload.script_file : "";
  const scriptFile = task.script_file ?? payloadScriptFile;
  const scriptMatch = scriptFile.match(/episode[-_\s]*(\d+)/i);
  if (scriptMatch) return Number(scriptMatch[1]);

  const resourceMatch = task.resource_id.match(/^E(\d+)(?:[A-Z]|$)/i);
  if (resourceMatch) return Number(resourceMatch[1]);

  const payloadEpisode = task.payload.episode;
  return typeof payloadEpisode === "number" && Number.isFinite(payloadEpisode)
    ? payloadEpisode
    : null;
}

function isEpisodeProductionTask(
  task: TaskItem,
  projectName: string,
  episode: number,
  scriptFile?: string,
): boolean {
  if (task.project_name !== projectName) return false;
  if (!["storyboard", "video", "grid"].includes(task.task_type)) return false;

  const targetScriptFile = normalizeScriptFileKey(scriptFile);
  const taskPayloadScriptFile =
    typeof task.payload.script_file === "string" ? task.payload.script_file : null;
  const taskScriptFile = normalizeScriptFileKey(task.script_file ?? taskPayloadScriptFile);
  if (targetScriptFile && taskScriptFile) {
    return targetScriptFile === taskScriptFile;
  }

  return resolveTaskEpisode(task) === episode;
}

function ProductionTaskProgressPanel({
  tasks,
  retryingTaskIds,
  onRetryTask,
}: {
  tasks: TaskItem[];
  retryingTaskIds: Set<string>;
  onRetryTask: (taskId: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const taskKinds = [
    { key: "storyboard", label: t("production_task_storyboard"), icon: Images },
    { key: "grid", label: t("production_task_grid"), icon: Sparkles },
    { key: "video", label: t("production_task_video"), icon: Clapperboard },
  ];
  const statusTotals = {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    succeeded: tasks.filter((task) => task.status === "succeeded").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
  const failedTasks = tasks.filter((task) => task.status === "failed");

  return (
    <section className="mb-4 rounded-xl border border-gray-800 bg-gray-900/70 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-100">{t("production_task_progress_title")}</p>
          <p className="mt-1 text-sm leading-6 text-gray-500">
            {t("production_task_progress_desc")}
          </p>
        </div>
        <div className="grid shrink-0 grid-cols-4 gap-2 text-center text-xs tabular-nums">
          <div className="rounded-lg border border-gray-800 bg-gray-950 px-2 py-1.5">
            <p className="text-gray-500">{t("queued_label")}</p>
            <p className="mt-0.5 text-gray-200">{statusTotals.queued}</p>
          </div>
          <div className="rounded-lg border border-indigo-400/25 bg-indigo-500/10 px-2 py-1.5">
            <p className="text-indigo-200/70">{t("running_label")}</p>
            <p className="mt-0.5 text-indigo-100">{statusTotals.running}</p>
          </div>
          <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2 py-1.5">
            <p className="text-emerald-200/70">{t("completed_label")}</p>
            <p className="mt-0.5 text-emerald-100">{statusTotals.succeeded}</p>
          </div>
          <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-2 py-1.5">
            <p className="text-red-200/70">{t("failed_label")}</p>
            <p className="mt-0.5 text-red-100">{statusTotals.failed}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {taskKinds.map(({ key, label, icon: Icon }) => {
          const kindTasks = tasks.filter((task) => task.task_type === key);
          const activeCount = kindTasks.filter((task) => task.status === "queued" || task.status === "running").length;
          const doneCount = kindTasks.filter((task) => task.status === "succeeded").length;
          const failedCount = kindTasks.filter((task) => task.status === "failed").length;
          return (
            <div key={key} className="rounded-lg border border-gray-800 bg-gray-950/55 p-3">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-200">{label}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                <span>{t("production_task_active_count", { count: activeCount })}</span>
                <span>{t("production_task_done_count", { count: doneCount })}</span>
                {failedCount > 0 && (
                  <span className="text-red-300">{t("production_task_failed_count", { count: failedCount })}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {failedTasks.length > 0 && (
        <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-red-100">
            <AlertTriangle className="h-4 w-4" />
            {t("production_task_failed_title", { count: failedTasks.length })}
          </div>
          <div className="space-y-2">
            {failedTasks.slice(0, 5).map((task) => (
              <div
                key={task.task_id}
                className="flex flex-col gap-2 rounded-md border border-red-400/15 bg-black/15 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-red-100">{task.resource_id}</p>
                  {task.error_message && (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-red-100/70">{task.error_message}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onRetryTask(task.task_id)}
                  disabled={retryingTaskIds.has(task.task_id)}
                  className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-red-300/25 px-2 text-xs font-medium text-red-100 transition-colors hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
                >
                  {retryingTaskIds.has(task.task_id) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  {t("retry_this_task")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type EpisodeArtifactKind = "storyboard" | "grid" | "video";

interface EpisodeArtifactItem {
  kind: EpisodeArtifactKind;
  resourceId: string;
  label: string;
  path: string | null;
  thumbnailPath?: string | null;
  externalUrl?: string | null;
  status?: GridGeneration["status"];
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function assetUrl(
  projectName: string,
  path: string | null | undefined,
  fingerprints: Record<string, number>,
): string | null {
  return path ? API.getFileUrl(projectName, path, fingerprints[path]) : null;
}

function AssetActionLink({
  href,
  label,
  icon,
  download,
}: {
  href: string | null;
  label: string;
  icon: React.ReactNode;
  download?: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      download={download}
      className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-gray-700 px-2 text-xs font-medium text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-800 hover:text-gray-100 focus-ring"
    >
      {icon}
      {label}
    </a>
  );
}

function ArtifactPreview({
  item,
  projectName,
  fingerprints,
}: {
  item: EpisodeArtifactItem;
  projectName: string;
  fingerprints: Record<string, number>;
}) {
  const imagePath = item.kind === "video" ? item.thumbnailPath : item.path;
  const previewUrl = assetUrl(projectName, imagePath, fingerprints);

  if (previewUrl) {
    return (
      <AuthenticatedImage
        src={previewUrl}
        alt={item.label}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }

  const Icon = item.kind === "video" ? Clapperboard : item.kind === "grid" ? Sparkles : Images;
  return (
    <div className="flex h-full w-full items-center justify-center bg-gray-950 text-gray-600">
      <Icon className="h-5 w-5" />
    </div>
  );
}

function ArtifactItemCard({
  item,
  projectName,
  fingerprints,
  busy,
  onRegenerate,
}: {
  item: EpisodeArtifactItem;
  projectName: string;
  fingerprints: Record<string, number>;
  busy: boolean;
  onRegenerate?: (item: EpisodeArtifactItem) => void;
}) {
  const { t } = useTranslation("dashboard");
  const localUrl = assetUrl(projectName, item.path, fingerprints);
  const viewUrl = localUrl ?? item.externalUrl ?? null;
  const downloadName = item.path ? fileNameFromPath(item.path) : undefined;

  return (
    <div
      data-testid={`episode-artifact-${item.kind}-${item.resourceId}`}
      className="overflow-hidden rounded-lg border border-gray-800 bg-gray-950/55"
    >
      <div className="aspect-video overflow-hidden border-b border-gray-800 bg-gray-950">
        <ArtifactPreview item={item} projectName={projectName} fingerprints={fingerprints} />
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-gray-200">{item.resourceId}</p>
            <p className="mt-0.5 truncate text-xs text-gray-500">{item.path ?? item.externalUrl}</p>
          </div>
          {item.status && (
            <span className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
              {t(`grid_status_${item.status}`)}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <AssetActionLink
            href={viewUrl}
            label={t("episode_artifacts_open")}
            icon={<ExternalLink className="h-3.5 w-3.5" />}
          />
          <AssetActionLink
            href={localUrl}
            label={t("episode_artifacts_download")}
            icon={<Download className="h-3.5 w-3.5" />}
            download={downloadName}
          />
          {onRegenerate && (
            <button
              type="button"
              onClick={() => onRegenerate(item)}
              disabled={busy}
              className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-indigo-400/35 px-2 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {busy ? t("episode_artifacts_regenerating") : t("episode_artifacts_regenerate")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactSection({
  title,
  ready,
  total,
  items,
  projectName,
  fingerprints,
  busyIds,
  onRegenerate,
  countOnly,
}: {
  title: string;
  ready: number;
  total: number;
  items: EpisodeArtifactItem[];
  projectName: string;
  fingerprints: Record<string, number>;
  busyIds: Set<string>;
  onRegenerate?: (item: EpisodeArtifactItem) => void;
  countOnly?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-200">{title}</p>
        <span className="text-xs text-gray-500">
          {countOnly
            ? t("episode_artifacts_item_count", { count: ready })
            : t("episode_artifacts_ready_count", { ready, total })}
        </span>
      </div>
      {items.length > 0 ? (
        <div className="grid max-h-[28rem] gap-3 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <ArtifactItemCard
              key={`${item.kind}-${item.resourceId}-${item.path ?? item.externalUrl ?? ""}`}
              item={item}
              projectName={projectName}
              fingerprints={fingerprints}
              busy={busyIds.has(item.resourceId)}
              onRegenerate={onRegenerate}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-800 bg-gray-950/35 px-3 py-4 text-sm text-gray-600">
          {t("episode_artifacts_no_items")}
        </div>
      )}
    </div>
  );
}

function EpisodeArtifactsPanel({
  projectName,
  episodeScript,
  scriptFile,
  segments,
  contentMode,
  grids,
  isGridMode,
  activeStoryboardIds,
  activeVideoIds,
  regeneratingGridIds,
  onRegenerateEpisodeScript,
  onRegenerateStoryboard,
  onRegenerateVideo,
  onRegenerateGrid,
  generatingEpisodeScript,
}: {
  projectName: string;
  episodeScript: EpisodeScript;
  scriptFile?: string;
  segments: Segment[];
  contentMode: "narration" | "drama";
  grids: GridGeneration[];
  isGridMode: boolean;
  activeStoryboardIds: Set<string>;
  activeVideoIds: Set<string>;
  regeneratingGridIds: Set<string>;
  onRegenerateEpisodeScript?: () => void;
  onRegenerateStoryboard?: (segmentId: string) => void;
  onRegenerateVideo?: (segmentId: string) => void;
  onRegenerateGrid?: (gridId: string) => void;
  generatingEpisodeScript?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const fingerprints = useProjectsStore((s) => s.assetFingerprints);
  const scriptUrl = assetUrl(projectName, scriptFile, fingerprints);
  const storyboardItems = segments
    .flatMap<EpisodeArtifactItem>((segment) => {
      const assets = segment.generated_assets;
      const resourceId = getSegmentId(segment, contentMode);
      if (!assets?.storyboard_image) return [];
      return [{
        kind: "storyboard" as const,
        resourceId,
        label: `${resourceId} ${t("production_task_storyboard")}`,
        path: assets.storyboard_image,
      }];
    });
  const videoItems = segments
    .flatMap<EpisodeArtifactItem>((segment) => {
      const assets = segment.generated_assets;
      const resourceId = getSegmentId(segment, contentMode);
      if (!assets?.video_clip && !assets?.video_uri) return [];
      return [{
        kind: "video" as const,
        resourceId,
        label: `${resourceId} ${t("production_task_video")}`,
        path: assets.video_clip,
        thumbnailPath: assets.video_thumbnail,
        externalUrl: assets.video_uri,
      }];
    });
  const gridItems = isGridMode
    ? grids
      .filter((grid) => grid.episode === episodeScript.episode && grid.grid_image_path)
      .map((grid) => ({
        kind: "grid" as const,
        resourceId: grid.id,
        label: `${grid.id} ${t("production_task_grid")}`,
        path: grid.grid_image_path,
        status: grid.status,
      }))
    : [];

  const stats = [
    {
      key: "script",
      label: t("episode_artifacts_script"),
      value: episodeScript ? "1 / 1" : "0 / 1",
      icon: FileJson,
    },
    {
      key: "storyboards",
      label: t("episode_artifacts_storyboards"),
      value: `${storyboardItems.length} / ${segments.length}`,
      icon: Images,
    },
    {
      key: "grids",
      label: t("episode_artifacts_grids"),
      value: String(gridItems.length),
      icon: Sparkles,
    },
    {
      key: "videos",
      label: t("episode_artifacts_videos"),
      value: `${videoItems.length} / ${segments.length}`,
      icon: Clapperboard,
    },
  ];

  return (
    <section className="mb-4 rounded-xl border border-gray-800 bg-gray-900/70 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-100">{t("episode_artifacts_title")}</p>
          <p className="mt-1 text-sm leading-6 text-gray-500">{t("episode_artifacts_desc")}</p>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {stats.map(({ key, label, value, icon: Icon }) => (
            <div key={key} className="rounded-lg border border-gray-800 bg-gray-950 px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-gray-500">
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </div>
              <p className="mt-1 font-mono text-sm text-gray-200">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/55 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-200">{t("episode_artifacts_script")}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-gray-500">
              {scriptFile ?? t("episode_artifacts_no_items")}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AssetActionLink
              href={scriptUrl}
              label={t("episode_artifacts_open")}
              icon={<ExternalLink className="h-3.5 w-3.5" />}
            />
            <AssetActionLink
              href={scriptUrl}
              label={t("episode_artifacts_download")}
              icon={<Download className="h-3.5 w-3.5" />}
              download={scriptFile ? fileNameFromPath(scriptFile) : undefined}
            />
            {onRegenerateEpisodeScript && (
              <button
                type="button"
                onClick={onRegenerateEpisodeScript}
                disabled={generatingEpisodeScript}
                className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-indigo-400/35 px-2 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
              >
                {generatingEpisodeScript ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                {generatingEpisodeScript ? t("episode_artifacts_regenerating") : t("episode_artifacts_regenerate")}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        <ArtifactSection
          title={t("episode_artifacts_storyboards")}
          ready={storyboardItems.length}
          total={segments.length}
          items={storyboardItems}
          projectName={projectName}
          fingerprints={fingerprints}
          busyIds={activeStoryboardIds}
          onRegenerate={onRegenerateStoryboard ? (item) => onRegenerateStoryboard(item.resourceId) : undefined}
        />
        {isGridMode && (
          <ArtifactSection
            title={t("episode_artifacts_grids")}
            ready={gridItems.length}
            total={gridItems.length}
            items={gridItems}
            projectName={projectName}
            fingerprints={fingerprints}
            busyIds={regeneratingGridIds}
            onRegenerate={onRegenerateGrid ? (item) => onRegenerateGrid(item.resourceId) : undefined}
            countOnly
          />
        )}
        <ArtifactSection
          title={t("episode_artifacts_videos")}
          ready={videoItems.length}
          total={segments.length}
          items={videoItems}
          projectName={projectName}
          fingerprints={fingerprints}
          busyIds={activeVideoIds}
          onRegenerate={onRegenerateVideo ? (item) => onRegenerateVideo(item.resourceId) : undefined}
        />
      </div>
    </section>
  );
}

type DeliveryCheckStatus = "pass" | "warning" | "fail";

interface DeliveryCheckItem {
  key: string;
  label: string;
  detail: string;
  status: DeliveryCheckStatus;
  Icon: typeof FileJson;
}

function DeliveryCheckRow({ item }: { item: DeliveryCheckItem }) {
  const statusClass = {
    pass: "border-emerald-400/20 bg-emerald-500/5 text-emerald-200",
    warning: "border-amber-400/20 bg-amber-500/5 text-amber-200",
    fail: "border-red-400/20 bg-red-500/5 text-red-200",
  }[item.status];
  const DotIcon = item.status === "pass" ? CheckCircle2 : AlertTriangle;

  return (
    <div className={`rounded-lg border p-3 ${statusClass}`}>
      <div className="flex items-start gap-2">
        <item.Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-80" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <DotIcon className="h-3.5 w-3.5 shrink-0" />
            <p className="text-sm font-medium">{item.label}</p>
          </div>
          <p className="mt-1 text-xs leading-5 opacity-75">{item.detail}</p>
        </div>
      </div>
    </div>
  );
}

function EpisodeDeliveryCheckPanel({
  hasScript,
  hasDraft,
  segments,
  isGridMode,
  gridGroupStatus,
  failedTasks,
  activeStoryboardIds,
  activeVideoIds,
  rawMissingStoryboardCount,
  rawMissingReadyVideoCount,
  missingReadyVideoCount,
  generatingEpisodeScript,
  generatingEpisodeStoryboards,
  generatingEpisodeVideos,
  generatingAllGrids,
  retryingTaskIds,
  onGenerateEpisodeScript,
  onGenerateStoryboards,
  onGenerateGrids,
  onGenerateVideos,
  onRetryFailedTasks,
}: {
  hasScript: boolean;
  hasDraft: boolean;
  segments: Segment[];
  isGridMode: boolean;
  gridGroupStatus: { ready: number; inProgress: number; missing: number; total: number };
  failedTasks: TaskItem[];
  activeStoryboardIds: Set<string>;
  activeVideoIds: Set<string>;
  rawMissingStoryboardCount: number;
  rawMissingReadyVideoCount: number;
  missingReadyVideoCount: number;
  generatingEpisodeScript?: boolean;
  generatingEpisodeStoryboards?: boolean;
  generatingEpisodeVideos?: boolean;
  generatingAllGrids?: boolean;
  retryingTaskIds: Set<string>;
  onGenerateEpisodeScript?: () => void;
  onGenerateStoryboards?: () => void;
  onGenerateGrids?: () => void;
  onGenerateVideos?: () => void;
  onRetryFailedTasks?: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const total = segments.length;
  const storyboardReadyCount = hasScript ? Math.max(total - rawMissingStoryboardCount, 0) : 0;
  const videoReadyCount = hasScript
    ? segments.filter((segment) => Boolean(segment.generated_assets?.video_clip)).length
    : 0;
  const missingVideoCount = hasScript ? Math.max(total - videoReadyCount, 0) : 0;
  const missingThumbnailCount = hasScript
    ? segments.filter(
      (segment) =>
        Boolean(segment.generated_assets?.video_clip) &&
        !segment.generated_assets?.video_thumbnail,
    ).length
    : 0;
  const hasActiveStoryboardWork = activeStoryboardIds.size > 0 || generatingEpisodeStoryboards || generatingAllGrids || gridGroupStatus.inProgress > 0;
  const hasActiveVideoWork = activeVideoIds.size > 0 || generatingEpisodeVideos;
  const retryingFailedCount = failedTasks.filter((task) => retryingTaskIds.has(task.task_id)).length;
  const blockingIssueCount = [
    !hasScript,
    hasScript && rawMissingStoryboardCount > 0,
    hasScript && missingVideoCount > 0,
    failedTasks.length > 0,
  ].filter(Boolean).length;
  const warningCount = missingThumbnailCount > 0 ? 1 : 0;
  const readyForDelivery = blockingIssueCount === 0;

  const checks: DeliveryCheckItem[] = [
    {
      key: "script",
      label: t("delivery_check_script"),
      detail: hasScript
        ? t("delivery_check_script_ready")
        : hasDraft
          ? t("delivery_check_script_from_draft")
          : t("delivery_check_script_missing"),
      status: hasScript ? "pass" : "fail",
      Icon: FileJson,
    },
    {
      key: "storyboards",
      label: isGridMode ? t("delivery_check_grids") : t("delivery_check_storyboards"),
      detail: !hasScript
        ? t("delivery_check_blocked_by_script")
        : isGridMode
          ? t("delivery_check_grids_detail", {
            ready: storyboardReadyCount,
            total,
            groupReady: gridGroupStatus.ready,
            groupTotal: gridGroupStatus.total,
          })
          : t("delivery_check_storyboards_detail", { ready: storyboardReadyCount, total }),
      status: !hasScript || rawMissingStoryboardCount > 0 ? "fail" : "pass",
      Icon: isGridMode ? Sparkles : Images,
    },
    {
      key: "videos",
      label: t("delivery_check_videos"),
      detail: !hasScript
        ? t("delivery_check_blocked_by_script")
        : t("delivery_check_videos_detail", {
          ready: videoReadyCount,
          total,
          readyToGenerate: rawMissingReadyVideoCount,
        }),
      status: !hasScript || missingVideoCount > 0 ? "fail" : "pass",
      Icon: Clapperboard,
    },
    {
      key: "failed",
      label: t("delivery_check_failed_tasks"),
      detail: failedTasks.length > 0
        ? t("delivery_check_failed_tasks_detail", { count: failedTasks.length })
        : t("delivery_check_failed_tasks_ready"),
      status: failedTasks.length > 0 ? "fail" : "pass",
      Icon: AlertTriangle,
    },
    {
      key: "thumbnails",
      label: t("delivery_check_thumbnails"),
      detail: missingThumbnailCount > 0
        ? t("delivery_check_thumbnails_missing", { count: missingThumbnailCount })
        : t("delivery_check_thumbnails_ready"),
      status: missingThumbnailCount > 0 ? "warning" : "pass",
      Icon: Images,
    },
  ];

  const primaryBusy =
    generatingEpisodeScript ||
    generatingEpisodeStoryboards ||
    generatingEpisodeVideos ||
    generatingAllGrids ||
    (failedTasks.length > 0 && retryingFailedCount > 0);
  const primaryDisabled = Boolean(
    primaryBusy ||
    readyForDelivery ||
    (!hasScript && !onGenerateEpisodeScript) ||
    (hasScript && failedTasks.length > 0 && !onRetryFailedTasks) ||
    (hasScript && failedTasks.length === 0 && rawMissingStoryboardCount > 0 && !(isGridMode ? onGenerateGrids : onGenerateStoryboards)) ||
    (hasScript && failedTasks.length === 0 && rawMissingStoryboardCount === 0 && missingReadyVideoCount > 0 && !onGenerateVideos) ||
    (hasScript && failedTasks.length === 0 && rawMissingStoryboardCount === 0 && missingVideoCount > 0 && missingReadyVideoCount === 0),
  );

  const handleAutoFix = () => {
    if (readyForDelivery) return;
    if (failedTasks.length > 0) {
      onRetryFailedTasks?.();
      return;
    }
    if (!hasScript) {
      onGenerateEpisodeScript?.();
      return;
    }
    if (rawMissingStoryboardCount > 0) {
      if (hasActiveStoryboardWork) return;
      if (isGridMode) {
        onGenerateGrids?.();
      } else {
        onGenerateStoryboards?.();
      }
      return;
    }
    if (missingReadyVideoCount > 0 && !hasActiveVideoWork) {
      onGenerateVideos?.();
    }
  };

  return (
    <section className={`mb-4 rounded-xl border p-4 ${
      readyForDelivery
        ? "border-emerald-400/25 bg-emerald-500/5"
        : "border-amber-400/25 bg-amber-500/5"
    }`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {readyForDelivery ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-300" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-300" />
            )}
            <p className="text-sm font-semibold text-gray-100">{t("delivery_check_title")}</p>
          </div>
          <p className="mt-1 text-sm leading-6 text-gray-400">
            {readyForDelivery
              ? warningCount > 0
                ? t("delivery_check_ready_with_warnings", { count: warningCount })
                : t("delivery_check_ready")
              : t("delivery_check_needs_work", { count: blockingIssueCount })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {failedTasks.length > 0 && onRetryFailedTasks && (
            <button
              type="button"
              onClick={onRetryFailedTasks}
              disabled={retryingFailedCount > 0}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-300/30 px-3 text-sm font-medium text-red-100 transition-colors hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
            >
              {retryingFailedCount > 0 ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              {t("delivery_check_retry_failed")}
            </button>
          )}
          <button
            type="button"
            onClick={handleAutoFix}
            disabled={primaryDisabled}
            className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors focus-ring ${
              readyForDelivery
                ? "cursor-not-allowed bg-emerald-600/20 text-emerald-200"
                : primaryDisabled
                  ? "cursor-not-allowed border border-gray-800 bg-gray-900 text-gray-600"
                  : "bg-indigo-600 text-white hover:bg-indigo-500"
            }`}
          >
            {primaryBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : readyForDelivery ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {readyForDelivery ? t("delivery_check_export_ready") : t("delivery_check_auto_fix")}
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        {checks.map((item) => (
          <DeliveryCheckRow key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

/** Group segments by segment_break into contiguous groups. */
function groupBySegmentBreak(segments: Segment[]): Segment[][] {
  const groups: Segment[][] = [];
  let current: Segment[] = [];
  for (const seg of segments) {
    if (seg.segment_break && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(seg);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Compute grid size for a group based on scene count and aspect ratio.
 *  Mirrors backend calculate_grid_layout + chunking logic in grids.py. */
function computeGridSize(
  count: number,
  aspectRatio: string = "9:16",
): { gridSize: string | null; rows: number; cols: number; cellCount: number; batchCount: number } {
  if (count < 1) return { gridSize: null, rows: 0, cols: 0, cellCount: 0, batchCount: 0 };
  const [w, h] = aspectRatio.split(":").map(Number);
  const isHorizontal = w > h;
  const effective = Math.min(count, 9);

  let gridSize: string;
  let cellCount: number;
  let rows: number;
  let cols: number;

  if (effective <= 4) {
    gridSize = "grid_4";
    cellCount = 4;
    rows = 2;
    cols = 2;
  } else if (effective <= 6) {
    gridSize = "grid_6";
    cellCount = 6;
    rows = isHorizontal ? 3 : 2;
    cols = isHorizontal ? 2 : 3;
  } else {
    gridSize = "grid_9";
    cellCount = 9;
    rows = 3;
    cols = 3;
  }

  const batchCount = count > cellCount ? Math.ceil(count / cellCount) : 1;

  return { gridSize, rows, cols, cellCount, batchCount };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TimelineCanvasProps {
  projectName: string;
  episode: number;
  episodeTitle?: string;
  hasDraft?: boolean;
  episodeScript: EpisodeScript | null;
  scriptFile?: string;
  projectData: ProjectData | null;
  onUpdatePrompt?: (
    segmentId: string,
    fieldOrPatch: string | Record<string, unknown>,
    value?: unknown,
    scriptFile?: string,
  ) => void;
  onGenerateStoryboard?: (segmentId: string, scriptFile?: string) => void;
  onGenerateVideo?: (segmentId: string, scriptFile?: string) => void;
  onGenerateGrid?: (episode: number, scriptFile: string, sceneIds?: string[]) => void;
  onGenerateEpisodeScript?: (episode: number) => void;
  generatingEpisodeScript?: boolean;
  onGenerateEpisodeStoryboards?: (episode: number, scriptFile: string) => void;
  onGenerateEpisodeVideos?: (episode: number, scriptFile: string) => void;
  generatingEpisodeStoryboards?: boolean;
  generatingEpisodeVideos?: boolean;
  durationOptions?: number[];
  onRestoreStoryboard?: () => Promise<void> | void;
  onRestoreVideo?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Main canvas container that renders a vertical list of SegmentCards for
 * the currently selected episode.
 *
 * Shows episode header (title, segment count, duration), followed by the
 * full timeline of segment cards with spacing.
 */
export function TimelineCanvas({
  projectName,
  episode,
  episodeTitle,
  hasDraft,
  episodeScript,
  scriptFile,
  projectData,
  durationOptions,
  onUpdatePrompt,
  onGenerateStoryboard,
  onGenerateVideo,
  onGenerateGrid,
  onGenerateEpisodeScript,
  generatingEpisodeScript,
  onGenerateEpisodeStoryboards,
  onGenerateEpisodeVideos,
  generatingEpisodeStoryboards,
  generatingEpisodeVideos,
  onRestoreStoryboard,
  onRestoreVideo,
}: TimelineCanvasProps) {
  const { t } = useTranslation("dashboard");
  const {
    checkingGenerationPreflight,
    generationPreflightDialog,
    runWithGenerationPreflight,
  } = useGenerationPreflightGate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentMode = projectData?.content_mode ?? "narration";

  const hasScript = Boolean(episodeScript);
  const showTabs = Boolean(hasDraft);
  const defaultTab = hasScript ? "timeline" : "preprocessing";
  const [activeTab, setActiveTab] = useState<"preprocessing" | "timeline">(defaultTab);

  // Auto-switch to timeline when script becomes available
  useEffect(() => {
    if (hasScript) setActiveTab("timeline");
  }, [hasScript]);

  const episodeCost = useCostStore((s) =>
    episodeScript ? s.getEpisodeCost(episodeScript.episode) : undefined,
  );
  const debouncedFetch = useCostStore((s) => s.debouncedFetch);
  const tasks = useTasksStore((s) => s.tasks);
  const [retryingProductionTaskIds, setRetryingProductionTaskIds] = useState<Set<string>>(() => new Set());
  const [regeneratingArtifactGridIds, setRegeneratingArtifactGridIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!projectName) return;
    debouncedFetch(projectName);
  }, [projectName, episodeScript?.episode, debouncedFetch]);

  // Determine aspect ratio — use project config if available, otherwise defaults
  const aspectRatio =
    typeof projectData?.aspect_ratio === "string"
      ? projectData.aspect_ratio
      : projectData?.aspect_ratio?.storyboard ??
        (contentMode === "narration" ? "9:16" : "16:9");

  // Pick the correct array (segments for narration, scenes for drama)
  const segments = useMemo<Segment[]>(
    () =>
      !episodeScript || !projectData
        ? []
        : contentMode === "narration"
          ? ((episodeScript as NarrationEpisodeScript).segments ?? [])
          : ((episodeScript as DramaEpisodeScript).scenes ?? []),
    [contentMode, episodeScript, projectData],
  );
  const segmentIndexMap = useMemo(
    () =>
      new Map(
        segments.map((segment, index) => [getSegmentId(segment, contentMode), index]),
      ),
    [contentMode, segments],
  );
  const activeStoryboardIds = useMemo(
    () =>
      scriptFile
        ? getActiveGenerationResourceIds(tasks, projectName, "storyboard", scriptFile)
        : new Set<string>(),
    [projectName, scriptFile, tasks],
  );
  const activeVideoIds = useMemo(
    () =>
      scriptFile
        ? getActiveGenerationResourceIds(tasks, projectName, "video", scriptFile)
        : new Set<string>(),
    [projectName, scriptFile, tasks],
  );
  const activeGridIds = useMemo(
    () =>
      scriptFile
        ? getActiveGenerationResourceIds(tasks, projectName, "grid", scriptFile)
        : new Set<string>(),
    [projectName, scriptFile, tasks],
  );
  const currentEpisodeProductionTasks = useMemo(
    () =>
      tasks.filter((task) =>
        isEpisodeProductionTask(task, projectName, episode, scriptFile),
      ),
    [episode, projectName, scriptFile, tasks],
  );
  const submitRetryProductionTask = useCallback(async (taskId: string) => {
    setRetryingProductionTaskIds((prev) => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    try {
      const result = await API.retryTask(taskId);
      useAppStore.getState().pushToast(
        result.deduped ? t("task_retry_deduped") : t("task_retry_queued"),
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(
        t("task_retry_failed", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setRetryingProductionTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }, [t]);

  const handleRetryProductionTask = useCallback(async (taskId: string) => {
    const task = currentEpisodeProductionTasks.find((item) => item.task_id === taskId);
    const taskType = task ? toGenerationPreflightTaskType(task.task_type) : null;
    if (task && taskType) {
      await runWithGenerationPreflight(
        {
          projectName: task.project_name,
          taskType,
          resourceId: task.resource_id || task.task_id,
          targetLabel: task.resource_id || task.task_type,
          payload: task.payload ?? {},
        },
        () => submitRetryProductionTask(taskId),
      );
      return;
    }

    await submitRetryProductionTask(taskId);
  }, [currentEpisodeProductionTasks, runWithGenerationPreflight, submitRetryProductionTask]);
  const currentEpisodeFailedTasks = useMemo(
    () => currentEpisodeProductionTasks.filter((task) => task.status === "failed"),
    [currentEpisodeProductionTasks],
  );
  const handleRetryFailedProductionTasks = useCallback(() => {
    if (currentEpisodeFailedTasks.length === 0) return;
    const firstTask = currentEpisodeFailedTasks[0];
    const taskType = toGenerationPreflightTaskType(firstTask.task_type);
    if (!taskType) {
      currentEpisodeFailedTasks.forEach((task) => {
        void submitRetryProductionTask(task.task_id);
      });
      return;
    }
    void runWithGenerationPreflight(
      {
        projectName: firstTask.project_name,
        taskType,
        resourceId: `retry-failed-${episode}`,
        targetLabel: t("delivery_check_retry_failed"),
        payload: firstTask.payload ?? {},
        count: currentEpisodeFailedTasks.length,
      },
      async () => {
        await Promise.all(currentEpisodeFailedTasks.map((task) => submitRetryProductionTask(task.task_id)));
      },
    );
  }, [
    currentEpisodeFailedTasks,
    episode,
    runWithGenerationPreflight,
    submitRetryProductionTask,
    t,
  ]);

  // Grid mode state
  const gridsRevision = useAppStore((s) => s.gridsRevision);
  const currentEpisodeMeta = projectData?.episodes?.find((e) => e.episode === episode);
  const isGridMode = effectiveMode(projectData, currentEpisodeMeta) === "grid";
  const segmentGroups = useMemo(
    () => (isGridMode ? groupBySegmentBreak(segments) : []),
    [isGridMode, segments],
  );
  const [generatingGridGroups, setGeneratingGridGroups] = useState<Set<number>>(new Set());
  const [generatingAllGrids, setGeneratingAllGrids] = useState(false);
  const [grids, setGrids] = useState<GridGeneration[]>([]);
  const [gridsVersion, setGridsVersion] = useState(0);

  const refreshGrids = useCallback(() => {
    if (!isGridMode || !projectName) return;
    API.listGrids(projectName).then((data) => {
      setGrids(data);
      setGridsVersion((v) => v + 1);
    }).catch(() => {/* silently ignore */});
  }, [isGridMode, projectName]);

  // Fetch grids list for the current episode when in grid mode
  // Also re-fetch when gridsRevision changes (triggered by grid_ready SSE events)
  useEffect(() => {
    refreshGrids();
  }, [refreshGrids, episodeScript, gridsRevision]);

  /**
   * Find all grid IDs whose scene_ids are a subset of the given group.
   * Handles batched grids: a group with 32 scenes may have 4 grids of ~9 each.
   * Deduplicates by scene_ids key — keeps only the newest grid per unique batch.
   */
  const getLatestGridsForGroup = useCallback((groupScenes: Segment[]): GridGeneration[] => {
    const groupIdSet = new Set(groupScenes.map((s) => getSegmentId(s, contentMode)));
    const matched = grids.filter((g) =>
      g.episode === episode &&
      g.scene_ids.length > 0 &&
      g.scene_ids.every((id) => groupIdSet.has(id)),
    );
    // Deduplicate: for grids with identical scene_ids, keep the newest one
    const byKey = new Map<string, typeof matched[number]>();
    for (const g of matched) {
      const key = [...g.scene_ids].sort().join(",");
      const existing = byKey.get(key);
      if (!existing || g.created_at > existing.created_at) {
        byKey.set(key, g);
      }
    }
    return Array.from(byKey.values())
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [contentMode, episode, grids]);

  const getGridIdsForGroup = useCallback((groupScenes: Segment[]): string[] => {
    return getLatestGridsForGroup(groupScenes).map((g) => g.id);
  }, [getLatestGridsForGroup]);

  const hasInProgressGridForGroup = useCallback((groupScenes: Segment[]): boolean => {
    return activeGridIds.size > 0 || getLatestGridsForGroup(groupScenes).some(isGridInProgress);
  }, [activeGridIds, getLatestGridsForGroup]);

  const handleGenerateGroupGrid = useCallback(
    (groupIndex: number, groupScenes: Segment[]) => {
      if (!onGenerateGrid || !scriptFile) return;
      const sceneIds = groupScenes.map((s) => getSegmentId(s, contentMode));
      const gridBatchCount = computeGridSize(groupScenes.length, aspectRatio).batchCount;
      void runWithGenerationPreflight(
        {
          projectName,
          taskType: "grid",
          resourceId: `episode-${episode}-grid-${groupIndex + 1}`,
          targetLabel: `${t("generate_grid_btn")} ${groupIndex + 1}`,
          payload: { script_file: scriptFile, scene_ids: sceneIds },
          count: gridBatchCount,
        },
        () => {
          setGeneratingGridGroups((prev) => new Set(prev).add(groupIndex));
          onGenerateGrid(episode, scriptFile, sceneIds);
          setTimeout(() => {
            setGeneratingGridGroups((prev) => {
              const next = new Set(prev);
              next.delete(groupIndex);
              return next;
            });
            refreshGrids();
          }, 3000);
        },
      );
    },
    [aspectRatio, contentMode, episode, onGenerateGrid, projectName, refreshGrids, runWithGenerationPreflight, scriptFile, t],
  );

  const handleGenerateAllGrids = useCallback(() => {
    if (!onGenerateGrid || !scriptFile) return;
    if (segmentGroups.some((group) => hasInProgressGridForGroup(group))) {
      useAppStore.getState().pushToast(t("grid_batch_already_active"), "warning");
      return;
    }
    const gridBatchCount = segmentGroups.reduce(
      (sum, group) => sum + computeGridSize(group.length, aspectRatio).batchCount,
      0,
    );
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "grid",
        resourceId: `episode-${episode}-grids`,
        targetLabel: t("generate_all_grids"),
        payload: { script_file: scriptFile },
        count: Math.max(gridBatchCount, 1),
      },
      () => {
        setGeneratingAllGrids(true);
        onGenerateGrid(episode, scriptFile);
        setTimeout(() => {
          setGeneratingAllGrids(false);
          refreshGrids();
        }, 3000);
      },
    );
  }, [
    aspectRatio,
    episode,
    hasInProgressGridForGroup,
    onGenerateGrid,
    projectName,
    refreshGrids,
    runWithGenerationPreflight,
    scriptFile,
    segmentGroups,
    t,
  ]);

  const handleRegenerateArtifactGrid = useCallback((gridId: string) => {
    if (!gridId || regeneratingArtifactGridIds.has(gridId)) return;
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "grid",
        resourceId: gridId,
        targetLabel: gridId,
        payload: { grid_id: gridId },
      },
      async () => {
        setRegeneratingArtifactGridIds((prev) => new Set(prev).add(gridId));
        try {
          await API.regenerateGrid(projectName, gridId);
          useAppStore.getState().pushToast(t("episode_artifact_grid_regenerate_submitted"), "success");
          refreshGrids();
        } catch (err) {
          useAppStore.getState().pushToast(
            t("grid_regenerate_failed") + `: ${errMsg(err)}`,
            "error",
          );
        } finally {
          setRegeneratingArtifactGridIds((prev) => {
            const next = new Set(prev);
            next.delete(gridId);
            return next;
          });
        }
      },
    );
  }, [projectName, refreshGrids, regeneratingArtifactGridIds, runWithGenerationPreflight, t]);

  const handleRegenerateArtifactStoryboard = useCallback((segmentId: string) => {
    if (!onGenerateStoryboard || !scriptFile) return;
    const segment = segments.find((item) => getSegmentId(item, contentMode) === segmentId);
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "storyboard",
        resourceId: segmentId,
        targetLabel: segmentId,
        payload: {
          script_file: scriptFile,
          prompt: segment ? getSegmentGenerationPrompt(segment, "image_prompt") : "",
        },
      },
      () => onGenerateStoryboard(segmentId, scriptFile),
    );
  }, [
    contentMode,
    onGenerateStoryboard,
    projectName,
    runWithGenerationPreflight,
    scriptFile,
    segments,
  ]);

  const handleRegenerateArtifactVideo = useCallback((segmentId: string) => {
    if (!onGenerateVideo || !scriptFile) return;
    const segment = segments.find((item) => getSegmentId(item, contentMode) === segmentId);
    const duration = segment && "duration_seconds" in segment ? segment.duration_seconds : undefined;
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "video",
        resourceId: segmentId,
        targetLabel: segmentId,
        payload: {
          script_file: scriptFile,
          prompt: segment ? getSegmentGenerationPrompt(segment, "video_prompt") : "",
          ...(typeof duration === "number" ? { duration_seconds: duration } : {}),
        },
      },
      () => onGenerateVideo(segmentId, scriptFile),
    );
  }, [
    contentMode,
    onGenerateVideo,
    projectName,
    runWithGenerationPreflight,
    scriptFile,
    segments,
  ]);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 5,
    measureElement: (element) => element?.getBoundingClientRect().height ?? 200,
  });
  const prepareScrollTarget = useCallback(
    (target: { id: string }) => {
      const index = segmentIndexMap.get(target.id);
      if (index == null) {
        return false;
      }
      virtualizer.scrollToIndex(index, { align: "center" });
      return true;
    },
    [segmentIndexMap, virtualizer],
  );

  // Respond to agent-triggered scroll targets for segments
  useScrollTarget("segment", { prepareTarget: prepareScrollTarget });

  const rawMissingStoryboardCount = useMemo(
    () => segments.filter((segment) => !segment.generated_assets?.storyboard_image).length,
    [segments],
  );
  const missingStoryboardCount = useMemo(
    () =>
      segments.filter((segment) => {
        const segmentId = getSegmentId(segment, contentMode);
        return !segment.generated_assets?.storyboard_image && !activeStoryboardIds.has(segmentId);
      }).length,
    [activeStoryboardIds, contentMode, segments],
  );
  const rawMissingVideoCount = useMemo(
    () =>
      segments.filter(
        (segment) =>
          segment.generated_assets?.storyboard_image &&
          !segment.generated_assets?.video_clip,
      ).length,
    [segments],
  );
  const missingVideoCount = useMemo(
    () =>
      segments.filter((segment) => {
        const segmentId = getSegmentId(segment, contentMode);
        return (
          Boolean(segment.generated_assets?.storyboard_image) &&
          !segment.generated_assets?.video_clip &&
          !activeVideoIds.has(segmentId)
        );
      }).length,
    [activeVideoIds, contentMode, segments],
  );
  const maxMissingReadyVideoDuration = useMemo(() => {
    const durations = segments
      .filter((segment) => {
        const segmentId = getSegmentId(segment, contentMode);
        return (
          Boolean(segment.generated_assets?.storyboard_image) &&
          !segment.generated_assets?.video_clip &&
          !activeVideoIds.has(segmentId)
        );
      })
      .map((segment) => segment.duration_seconds)
      .filter((duration): duration is number => typeof duration === "number" && Number.isFinite(duration));
    return durations.length > 0 ? Math.max(...durations) : undefined;
  }, [activeVideoIds, contentMode, segments]);
  const gridGroupStatus = useMemo(() => {
    if (!isGridMode) return { ready: 0, inProgress: 0, missing: 0, total: 0 };
    let ready = 0;
    let inProgress = 0;
    for (const group of segmentGroups) {
      if (getLatestGridsForGroup(group).length > 0) {
        ready += 1;
      } else if (hasInProgressGridForGroup(group)) {
        inProgress += 1;
      }
    }
    return {
      ready,
      inProgress,
      missing: Math.max(segmentGroups.length - ready - inProgress, 0),
      total: segmentGroups.length,
    };
  }, [getLatestGridsForGroup, hasInProgressGridForGroup, isGridMode, segmentGroups]);

  const handleGenerateEpisodeStoryboardsWithPreflight = useCallback(() => {
    if (!onGenerateEpisodeStoryboards || !scriptFile || missingStoryboardCount <= 0) return;
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "storyboard",
        resourceId: `episode-${episode}-storyboards`,
        targetLabel: t("generate_missing_storyboards", { count: missingStoryboardCount }),
        payload: { script_file: scriptFile },
        count: missingStoryboardCount,
      },
      () => onGenerateEpisodeStoryboards(episode, scriptFile),
    );
  }, [
    episode,
    missingStoryboardCount,
    onGenerateEpisodeStoryboards,
    projectName,
    runWithGenerationPreflight,
    scriptFile,
    t,
  ]);

  const handleGenerateEpisodeVideosWithPreflight = useCallback(() => {
    if (!onGenerateEpisodeVideos || !scriptFile || missingVideoCount <= 0) return;
    void runWithGenerationPreflight(
      {
        projectName,
        taskType: "video",
        resourceId: `episode-${episode}-videos`,
        targetLabel: t("generate_missing_videos", { count: missingVideoCount }),
        payload: {
          script_file: scriptFile,
          ...(maxMissingReadyVideoDuration ? { duration_seconds: maxMissingReadyVideoDuration } : {}),
        },
        count: missingVideoCount,
      },
      () => onGenerateEpisodeVideos(episode, scriptFile),
    );
  }, [
    episode,
    maxMissingReadyVideoDuration,
    missingVideoCount,
    onGenerateEpisodeVideos,
    projectName,
    runWithGenerationPreflight,
    scriptFile,
    t,
  ]);

  const episodeWorkflowAction = useMemo(() => {
    if (!episodeScript || !scriptFile || activeTab !== "timeline") return null;
    if (isGridMode) {
      if (gridGroupStatus.inProgress > 0 || generatingAllGrids) {
        return {
          kind: "grid-active" as const,
          Icon: Loader2,
          iconClassName: "text-blue-300 animate-spin",
          titleKey: "episode_workflow_grid_active_title",
          descKey: "episode_workflow_grid_active_desc",
          descParams: { count: gridGroupStatus.inProgress || gridGroupStatus.total },
          buttonKey: null,
          onClick: undefined,
          disabled: true,
        };
      }
      if (gridGroupStatus.missing > 0 && onGenerateGrid) {
        return {
          kind: "grid" as const,
          Icon: Sparkles,
          iconClassName: "text-blue-300",
          titleKey: "episode_workflow_grid_title",
          descKey: "episode_workflow_grid_desc",
          descParams: { count: gridGroupStatus.missing },
          buttonKey: "episode_workflow_generate_grids",
          onClick: handleGenerateAllGrids,
          disabled: false,
        };
      }
      return {
        kind: "complete" as const,
        Icon: CheckCircle2,
        iconClassName: "text-emerald-300",
        titleKey: "episode_workflow_complete_title",
        descKey: "episode_workflow_complete_desc",
        descParams: undefined,
        buttonKey: null,
        onClick: undefined,
        disabled: true,
      };
    }

    if (rawMissingStoryboardCount > 0) {
      if (missingStoryboardCount === 0) {
        return {
          kind: "storyboard-active" as const,
          Icon: Loader2,
          iconClassName: "text-blue-300 animate-spin",
          titleKey: "episode_workflow_storyboard_active_title",
          descKey: "episode_workflow_storyboard_active_desc",
          descParams: { count: rawMissingStoryboardCount },
          buttonKey: null,
          onClick: undefined,
          disabled: true,
        };
      }
      if (onGenerateEpisodeStoryboards) {
        return {
          kind: "storyboard" as const,
          Icon: Images,
          iconClassName: "text-blue-300",
          titleKey: "episode_workflow_storyboard_title",
          descKey: "episode_workflow_storyboard_desc",
          descParams: { count: missingStoryboardCount },
          buttonKey: "episode_workflow_generate_storyboards",
          onClick: handleGenerateEpisodeStoryboardsWithPreflight,
          disabled: Boolean(generatingEpisodeStoryboards),
        };
      }
    }

    if (rawMissingVideoCount > 0) {
      if (missingVideoCount === 0) {
        return {
          kind: "video-active" as const,
          Icon: Loader2,
          iconClassName: "text-emerald-300 animate-spin",
          titleKey: "episode_workflow_video_active_title",
          descKey: "episode_workflow_video_active_desc",
          descParams: { count: rawMissingVideoCount },
          buttonKey: null,
          onClick: undefined,
          disabled: true,
        };
      }
      if (onGenerateEpisodeVideos) {
        return {
          kind: "video" as const,
          Icon: Clapperboard,
          iconClassName: "text-emerald-300",
          titleKey: "episode_workflow_video_title",
          descKey: "episode_workflow_video_desc",
          descParams: { count: missingVideoCount },
          buttonKey: "episode_workflow_generate_videos",
          onClick: handleGenerateEpisodeVideosWithPreflight,
          disabled: Boolean(generatingEpisodeVideos),
        };
      }
    }

    return {
      kind: "complete" as const,
      Icon: CheckCircle2,
      iconClassName: "text-emerald-300",
      titleKey: "episode_workflow_complete_title",
      descKey: "episode_workflow_complete_desc",
      descParams: undefined,
      buttonKey: null,
      onClick: undefined,
      disabled: true,
    };
  }, [
    activeTab,
    episodeScript,
    generatingAllGrids,
    generatingEpisodeStoryboards,
    generatingEpisodeVideos,
    gridGroupStatus,
    handleGenerateAllGrids,
    handleGenerateEpisodeStoryboardsWithPreflight,
    handleGenerateEpisodeVideosWithPreflight,
    isGridMode,
    missingStoryboardCount,
    missingVideoCount,
    onGenerateGrid,
    onGenerateEpisodeStoryboards,
    onGenerateEpisodeVideos,
    rawMissingStoryboardCount,
    rawMissingVideoCount,
    scriptFile,
  ]);

  // Empty state — no episode selected or no content at all
  if (!projectData || (!episodeScript && !hasDraft)) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        {t("select_episode_hint")}
      </div>
    );
  }

  // Compute total duration from actual segments if available
  const totalDuration =
    episodeScript?.duration_seconds ??
    segments.reduce((sum, s) => sum + s.duration_seconds, 0);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <>
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="p-4">
        {/* ---- Episode header ---- */}
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-100">
            {episodeScript
              ? `E${episodeScript.episode}: ${episodeScript.title}`
              : `E${episode}${episodeTitle ? `: ${episodeTitle}` : ""}`}
          </h2>
          {episodeScript && (
            <p className="text-xs text-gray-500">
              {contentMode === "narration"
                ? t("segment_count", { count: segments.length })
                : t("scene_count_label", { count: segments.length })} · ~{totalDuration}s
            </p>
          )}
          {episodeCost && (
            <div className="mt-2 flex items-center gap-4 rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-xs tabular-nums">
              <span className="text-gray-600">{t("cost_estimate_short")}</span>
              <span className="text-gray-500">{t("cost_storyboard_short")} <span className="text-gray-300">{formatCost(episodeCost.totals.estimate.image)}</span></span>
              <span className="text-gray-500">{t("cost_video_short")} <span className="text-gray-300">{formatCost(episodeCost.totals.estimate.video)}</span></span>
              <span className="text-gray-500">{t("cost_total_short")} <span className="font-medium text-amber-400">{formatCost(totalBreakdown(episodeCost.totals.estimate))}</span></span>
              <span className="text-gray-700">|</span>
              <span className="text-gray-600">{t("cost_actual_short")}</span>
              <span className="text-gray-500">{t("cost_storyboard_short")} <span className="text-gray-300">{formatCost(episodeCost.totals.actual.image)}</span></span>
              <span className="text-gray-500">{t("cost_video_short")} <span className="text-gray-300">{formatCost(episodeCost.totals.actual.video)}</span></span>
              <span className="text-gray-500">{t("cost_total_short")} <span className="font-medium text-emerald-400">{formatCost(totalBreakdown(episodeCost.totals.actual))}</span></span>
            </div>
          )}
        </div>

        {!hasScript && hasDraft && onGenerateEpisodeScript && (
          <section className="mb-4 rounded-xl border border-indigo-400/25 bg-indigo-500/10 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-indigo-100">
                  {t("episode_workflow_draft_ready_title")}
                </p>
                <p className="mt-1 text-sm leading-6 text-indigo-100/75">
                  {t("episode_workflow_draft_ready_desc")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onGenerateEpisodeScript(episode)}
                disabled={generatingEpisodeScript}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
              >
                {generatingEpisodeScript ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileJson className="h-4 w-4" />
                )}
                {generatingEpisodeScript
                  ? t("episode_script_generating")
                  : t("generate_episode_script")}
              </button>
            </div>
          </section>
        )}

        {/* ---- Tab bar (only when draft exists) ---- */}
        {showTabs && (
          <div className="mb-4 flex items-center justify-between gap-3 border-b border-gray-800">
            <div className="flex min-w-0 gap-0">
              <button
                type="button"
                onClick={() => setActiveTab("preprocessing")}
                className={`border-b-2 px-4 py-2 text-sm transition-colors focus-ring rounded-t ${
                  activeTab === "preprocessing"
                    ? "border-indigo-500 text-indigo-400 font-medium"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {t("preprocessing_tab")}
              </button>
              <button
                type="button"
                onClick={() => hasScript && setActiveTab("timeline")}
                disabled={!hasScript}
                className={`border-b-2 px-4 py-2 text-sm transition-colors focus-ring rounded-t ${
                  activeTab === "timeline"
                    ? "border-indigo-500 text-indigo-400 font-medium"
                    : !hasScript
                      ? "border-transparent text-gray-700 cursor-not-allowed"
                      : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {t("timeline_tab")}
              </button>
            </div>
          </div>
        )}

        {episodeWorkflowAction && (
          <section className="mb-4 rounded-xl border border-gray-800 bg-gray-900/80 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <episodeWorkflowAction.Icon
                  className={`mt-0.5 h-5 w-5 shrink-0 ${episodeWorkflowAction.iconClassName}`}
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-100">
                    {t(episodeWorkflowAction.titleKey)}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-gray-400">
                    {t(episodeWorkflowAction.descKey, episodeWorkflowAction.descParams)}
                  </p>
                </div>
              </div>
              {episodeWorkflowAction.buttonKey && episodeWorkflowAction.onClick && (
                <button
                  type="button"
                  onClick={episodeWorkflowAction.onClick}
                  disabled={episodeWorkflowAction.disabled || checkingGenerationPreflight}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-3 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600 focus-ring"
                >
                  {episodeWorkflowAction.kind === "storyboard" ? (
                    <Images className="h-4 w-4" />
                  ) : episodeWorkflowAction.kind === "video" ? (
                    <Clapperboard className="h-4 w-4" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {t(episodeWorkflowAction.buttonKey)}
                </button>
              )}
            </div>
          </section>
        )}

        {(episodeScript || hasDraft) && (
          <EpisodeDeliveryCheckPanel
            hasScript={Boolean(episodeScript)}
            hasDraft={Boolean(hasDraft)}
            segments={segments}
            isGridMode={isGridMode}
            gridGroupStatus={gridGroupStatus}
            failedTasks={currentEpisodeFailedTasks}
            activeStoryboardIds={activeStoryboardIds}
            activeVideoIds={activeVideoIds}
            rawMissingStoryboardCount={rawMissingStoryboardCount}
            rawMissingReadyVideoCount={rawMissingVideoCount}
            missingReadyVideoCount={missingVideoCount}
            generatingEpisodeScript={generatingEpisodeScript}
            generatingEpisodeStoryboards={generatingEpisodeStoryboards}
            generatingEpisodeVideos={generatingEpisodeVideos}
            generatingAllGrids={generatingAllGrids}
            retryingTaskIds={retryingProductionTaskIds}
            onGenerateEpisodeScript={
              onGenerateEpisodeScript ? () => onGenerateEpisodeScript(episode) : undefined
            }
            onGenerateStoryboards={
              onGenerateEpisodeStoryboards && scriptFile
                ? handleGenerateEpisodeStoryboardsWithPreflight
                : undefined
            }
            onGenerateGrids={
              onGenerateGrid && scriptFile ? handleGenerateAllGrids : undefined
            }
            onGenerateVideos={
              onGenerateEpisodeVideos && scriptFile
                ? handleGenerateEpisodeVideosWithPreflight
                : undefined
            }
            onRetryFailedTasks={
              currentEpisodeFailedTasks.length > 0 ? handleRetryFailedProductionTasks : undefined
            }
          />
        )}

        {episodeScript && activeTab === "timeline" && currentEpisodeProductionTasks.length > 0 && (
          <ProductionTaskProgressPanel
            tasks={currentEpisodeProductionTasks}
            retryingTaskIds={retryingProductionTaskIds}
            onRetryTask={(taskId) => void handleRetryProductionTask(taskId)}
          />
        )}

        {episodeScript && activeTab === "timeline" && (
          <EpisodeArtifactsPanel
            projectName={projectName}
            episodeScript={episodeScript}
            scriptFile={scriptFile}
            segments={segments}
            contentMode={contentMode}
            grids={grids}
            isGridMode={isGridMode}
            activeStoryboardIds={activeStoryboardIds}
            activeVideoIds={activeVideoIds}
            regeneratingGridIds={regeneratingArtifactGridIds}
            onRegenerateEpisodeScript={
              onGenerateEpisodeScript ? () => onGenerateEpisodeScript(episode) : undefined
            }
            onRegenerateStoryboard={
              onGenerateStoryboard && scriptFile
                ? handleRegenerateArtifactStoryboard
                : undefined
            }
            onRegenerateVideo={
              onGenerateVideo && scriptFile
                ? handleRegenerateArtifactVideo
                : undefined
            }
            onRegenerateGrid={
              isGridMode ? handleRegenerateArtifactGrid : undefined
            }
            generatingEpisodeScript={generatingEpisodeScript}
          />
        )}

        {episodeScript && scriptFile && !isGridMode && (
          <div className="mb-4 flex flex-wrap gap-2">
            {onGenerateEpisodeStoryboards && (
              <button
                type="button"
                onClick={handleGenerateEpisodeStoryboardsWithPreflight}
                disabled={generatingEpisodeStoryboards || checkingGenerationPreflight || rawMissingStoryboardCount === 0}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-ring ${
                  generatingEpisodeStoryboards
                    ? "cursor-not-allowed border-blue-700 text-blue-300 opacity-75"
                    : rawMissingStoryboardCount === 0
                      ? "cursor-not-allowed border-gray-800 text-gray-600"
                      : "border-blue-600 text-blue-300 hover:bg-blue-600/10"
                }`}
              >
                {generatingEpisodeStoryboards ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Images className="h-3.5 w-3.5" />
                )}
                {generatingEpisodeStoryboards
                  ? t("storyboard_batch_submitting")
                  : rawMissingStoryboardCount === 0
                    ? t("storyboards_complete")
                    : missingStoryboardCount === 0
                      ? t("storyboard_batch_active_button")
                      : t("generate_missing_storyboards", { count: missingStoryboardCount })}
              </button>
            )}
            {onGenerateEpisodeVideos && (
              <button
                type="button"
                onClick={handleGenerateEpisodeVideosWithPreflight}
                disabled={generatingEpisodeVideos || checkingGenerationPreflight || rawMissingVideoCount === 0}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-ring ${
                  generatingEpisodeVideos
                    ? "cursor-not-allowed border-emerald-700 text-emerald-300 opacity-75"
                    : rawMissingVideoCount === 0
                      ? "cursor-not-allowed border-gray-800 text-gray-600"
                      : "border-emerald-600 text-emerald-300 hover:bg-emerald-600/10"
                }`}
              >
                {generatingEpisodeVideos ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Clapperboard className="h-3.5 w-3.5" />
                )}
                {generatingEpisodeVideos
                  ? t("video_batch_submitting")
                  : rawMissingVideoCount === 0
                    ? t("videos_complete")
                    : missingVideoCount === 0
                      ? t("video_batch_active_button")
                      : t("generate_missing_videos", { count: missingVideoCount })}
              </button>
            )}
          </div>
        )}

        {/* ---- Tab content ---- */}
        {activeTab === "preprocessing" && hasDraft ? (
          <PreprocessingView
            projectName={projectName}
            episode={episode}
            contentMode={contentMode}
          />
        ) : episodeScript ? (
          isGridMode && segmentGroups.length > 0 ? (
            /* ---- Grid mode: grouped segments without virtualization ---- */
            <div>
              {/* Batch generate all grids button */}
              {onGenerateGrid && scriptFile && (
                <div className="mb-4">
                  <motion.button
                    type="button"
                    onClick={handleGenerateAllGrids}
                    disabled={generatingAllGrids || checkingGenerationPreflight}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                      generatingAllGrids
                        ? "border-blue-700 text-blue-400 opacity-70 cursor-not-allowed"
                        : "border-blue-600 text-blue-400 hover:bg-blue-600/10"
                    }`}
                    animate={
                      generatingAllGrids
                        ? { opacity: [0.7, 1, 0.7] }
                        : { opacity: 1 }
                    }
                    transition={
                      generatingAllGrids
                        ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" }
                        : { duration: 0.3 }
                    }
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {generatingAllGrids ? (
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
                    {generatingAllGrids ? t("submitting") : t("generate_all_grids")}
                  </motion.button>
                </div>
              )}

              {segmentGroups.map((group, groupIdx) => {
                const gridResult = computeGridSize(group.length, aspectRatio);
                const hasInProgressGrid = hasInProgressGridForGroup(group);
                return (
                  <GridSegmentGroup
                    key={groupIdx}
                    groupIndex={groupIdx}
                    scenes={group}
                    gridSize={gridResult.gridSize}
                    sceneCount={group.length}
                    batchCount={gridResult.batchCount}
                    onGenerateGrid={() => handleGenerateGroupGrid(groupIdx, group)}
                    generatingGrid={generatingGridGroups.has(groupIdx) || hasInProgressGrid}
                    gridIds={getGridIdsForGroup(group)}
                    projectName={projectName}
                    onGridRegenerated={refreshGrids}
                    gridsVersion={gridsVersion}
                  >
                    {group.map((segment) => {
                      const segId = getSegmentId(segment, contentMode);
                      return (
                        <div id={`segment-${segId}`} key={segId}>
                          <SegmentCard
                            segment={segment}
                            contentMode={contentMode}
                            aspectRatio={aspectRatio}
                            characters={projectData.characters}
                            scenes={projectData.scenes ?? {}}
                            props={projectData.props ?? {}}
                            projectName={projectName}
                            scriptFile={scriptFile}
                            durationOptions={durationOptions}
                            isGridMode
                            onUpdatePrompt={onUpdatePrompt && ((id, fieldOrPatch, value) => onUpdatePrompt(id, fieldOrPatch, value, scriptFile))}
                            onGenerateStoryboard={onGenerateStoryboard && ((id) => onGenerateStoryboard(id, scriptFile))}
                            onGenerateVideo={onGenerateVideo && ((id) => onGenerateVideo(id, scriptFile))}
                            onRestoreStoryboard={onRestoreStoryboard}
                            onRestoreVideo={onRestoreVideo}
                            generatingStoryboard={activeStoryboardIds.has(segId)}
                            generatingVideo={activeVideoIds.has(segId)}
                          />
                        </div>
                      );
                    })}
                  </GridSegmentGroup>
                );
              })}
            </div>
          ) : (
            /* ---- Normal mode: virtualized flat list ---- */
            <div
              className="relative"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualItems.map((virtualItem) => {
                const segment = segments[virtualItem.index];
                const segId = getSegmentId(segment, contentMode);
                return (
                  <div
                    id={`segment-${segId}`}
                    key={segId}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                      paddingBottom: virtualItem.index === segments.length - 1 ? 0 : 16,
                    }}
                  >
                    <SegmentCard
                      segment={segment}
                      contentMode={contentMode}
                      aspectRatio={aspectRatio}
                      characters={projectData.characters}
                      scenes={projectData.scenes ?? {}}
                      props={projectData.props ?? {}}
                      projectName={projectName}
                      scriptFile={scriptFile}
                      durationOptions={durationOptions}
                      onUpdatePrompt={onUpdatePrompt && ((id, fieldOrPatch, value) => onUpdatePrompt(id, fieldOrPatch, value, scriptFile))}
                      onGenerateStoryboard={onGenerateStoryboard && ((id) => onGenerateStoryboard(id, scriptFile))}
                      onGenerateVideo={onGenerateVideo && ((id) => onGenerateVideo(id, scriptFile))}
                      onRestoreStoryboard={onRestoreStoryboard}
                      onRestoreVideo={onRestoreVideo}
                      generatingStoryboard={activeStoryboardIds.has(segId)}
                      generatingVideo={activeVideoIds.has(segId)}
                    />
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {/* Bottom spacer for scroll comfort */}
        <div className="h-16" />
      </div>
    </div>
    {generationPreflightDialog}
    </>
  );
}
