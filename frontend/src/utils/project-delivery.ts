import type { EpisodeMeta, EpisodeScript, ProjectData, TaskItem } from "@/types";
import { effectiveMode } from "@/utils/generation-mode";
import { getScriptByFileKey, getScriptGenerationItems, normalizeScriptFileKey } from "@/utils/script-generation";

export type ProjectDeliveryAction = "retry_failed" | "generate_script" | "produce" | "open" | "ready";

export interface ProjectDeliveryEpisodeCheck {
  episode: EpisodeMeta;
  action: ProjectDeliveryAction;
  scriptReady: boolean;
  storyboardReady: number;
  storyboardTotal: number;
  videoReady: number;
  videoTotal: number;
  failedTasks: number;
  activeTasks: number;
  missingThumbnails: number;
  blockingIssues: number;
}

export interface ProjectDeliverySummary {
  episodes: ProjectDeliveryEpisodeCheck[];
  totalEpisodes: number;
  scriptedEpisodes: number;
  readyEpisodes: number;
  storyboardReady: number;
  storyboardTotal: number;
  videoReady: number;
  videoTotal: number;
  failedTasks: number;
  activeTasks: number;
  missingThumbnails: number;
  blockingIssues: number;
  firstAction: ProjectDeliveryEpisodeCheck | null;
}

const PROJECT_PRODUCTION_TASK_TYPES = new Set(["storyboard", "video", "grid", "reference_video"]);

export function resolveTaskEpisode(task: { script_file: string | null; resource_id: string; payload: Record<string, unknown> }): number | null {
  const payloadScriptFile = typeof task.payload.script_file === "string" ? task.payload.script_file : "";
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

export function isEpisodeTask(task: TaskItem, projectName: string, episode: EpisodeMeta): boolean {
  if (task.project_name !== projectName) return false;
  if (!PROJECT_PRODUCTION_TASK_TYPES.has(task.task_type)) return false;

  const taskPayloadScriptFile = typeof task.payload.script_file === "string" ? task.payload.script_file : null;
  const taskScriptFile = normalizeScriptFileKey(task.script_file ?? taskPayloadScriptFile);
  const episodeScriptFile = normalizeScriptFileKey(episode.script_file);
  if (taskScriptFile && episodeScriptFile) {
    return taskScriptFile === episodeScriptFile;
  }

  return resolveTaskEpisode(task) === episode.episode;
}

export function countMissingVideoThumbnails(script: EpisodeScript | null): number {
  if (!script) return 0;
  const items = script.content_mode === "narration"
    ? script.segments ?? []
    : script.content_mode === "reference_video"
      ? script.video_units ?? []
      : script.scenes ?? [];
  return items.filter((item) => (
    Boolean(item.generated_assets?.video_clip) &&
    !item.generated_assets?.video_thumbnail
  )).length;
}

export function buildProjectDeliverySummary(
  projectData: ProjectData,
  currentScripts: Record<string, EpisodeScript>,
  tasks: TaskItem[],
  projectName: string,
): ProjectDeliverySummary {
  const episodes = projectData.episodes ?? [];
  const checks = episodes.map((episode): ProjectDeliveryEpisodeCheck => {
    const mode = effectiveMode(projectData, episode);
    const script = getScriptByFileKey(currentScripts, episode.script_file);
    const scriptItems = script ? getScriptGenerationItems(script) : [];
    const scriptItemTotal = scriptItems.length;
    const storyboardTotal = mode === "reference_video"
      ? 0
      : Math.max(
        scriptItemTotal ||
        episode.storyboards?.total ||
        episode.storyboards?.completed ||
        0,
        0,
      );
    const storyboardReady = mode === "reference_video"
      ? 0
      : scriptItemTotal > 0
        ? scriptItems.filter((item) => item.hasStoryboard).length
        : episode.storyboards?.completed ?? 0;
    const videoTotal = Math.max(
      scriptItemTotal ||
      episode.videos?.total ||
      episode.units_count ||
      (episode.status === "completed" ? episode.videos?.completed : episode.scenes_count) ||
      0,
      0,
    );
    const videoReady = scriptItemTotal > 0
      ? scriptItems.filter((item) => item.hasVideo).length
      : episode.videos?.completed ?? 0;
    const scriptReady = episode.script_status === "generated" || Boolean(script);
    const relatedTasks = tasks.filter((task) => isEpisodeTask(task, projectName, episode));
    const failedTasks = relatedTasks.filter((task) => task.status === "failed").length;
    const activeTasks = relatedTasks.filter((task) => task.status === "queued" || task.status === "running").length;
    const missingThumbnails = countMissingVideoThumbnails(script);
    const hasMissingStoryboards = storyboardTotal > storyboardReady;
    const hasMissingVideos = videoTotal > videoReady;
    const blockingIssues = [
      !scriptReady,
      hasMissingStoryboards,
      hasMissingVideos,
      failedTasks > 0,
    ].filter(Boolean).length;
    const action: ProjectDeliveryAction =
      failedTasks > 0
        ? "retry_failed"
        : !scriptReady && episode.script_status === "segmented"
          ? "generate_script"
          : !scriptReady || hasMissingStoryboards || hasMissingVideos
            ? "produce"
            : blockingIssues === 0
              ? "ready"
              : "open";

    return {
      episode,
      action,
      scriptReady,
      storyboardReady,
      storyboardTotal,
      videoReady,
      videoTotal,
      failedTasks,
      activeTasks,
      missingThumbnails,
      blockingIssues,
    };
  });

  return {
    episodes: checks,
    totalEpisodes: checks.length,
    scriptedEpisodes: checks.filter((check) => check.scriptReady).length,
    readyEpisodes: checks.filter((check) => check.blockingIssues === 0).length,
    storyboardReady: checks.reduce((sum, check) => sum + check.storyboardReady, 0),
    storyboardTotal: checks.reduce((sum, check) => sum + check.storyboardTotal, 0),
    videoReady: checks.reduce((sum, check) => sum + check.videoReady, 0),
    videoTotal: checks.reduce((sum, check) => sum + check.videoTotal, 0),
    failedTasks: checks.reduce((sum, check) => sum + check.failedTasks, 0),
    activeTasks: checks.reduce((sum, check) => sum + check.activeTasks, 0),
    missingThumbnails: checks.reduce((sum, check) => sum + check.missingThumbnails, 0),
    blockingIssues: checks.reduce((sum, check) => sum + check.blockingIssues, 0),
    firstAction: checks.find((check) => check.action !== "ready") ?? null,
  };
}

export function hasProjectExportGateIssues(summary: ProjectDeliverySummary | null | undefined): boolean {
  return Boolean(
    summary &&
    summary.totalEpisodes > 0 &&
    (summary.blockingIssues > 0 || summary.missingThumbnails > 0),
  );
}
