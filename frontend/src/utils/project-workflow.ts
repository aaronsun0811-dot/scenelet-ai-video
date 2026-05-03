import type { EpisodeMeta, ProjectData, ProjectStatus } from "@/types";

export const WORKFLOW_PHASES: ProjectStatus["current_phase"][] = [
  "setup",
  "worldbuilding",
  "scripting",
  "production",
  "completed",
];

export type ProjectWorkflowStage = {
  key: ProjectStatus["current_phase"];
  progress: number;
  actionLabelKey: string;
  actionDetailKey?: string;
  actionDetailParams?: Record<string, number | string>;
  actionPath: string;
  descriptionKey: string;
  descriptionParams?: Record<string, number>;
  state: "done" | "current" | "todo";
};

function percent(done: number, total: number, fallback = 0) {
  if (total <= 0) return fallback;
  return Math.round((done / total) * 100);
}

function episodePath(episode?: EpisodeMeta) {
  return episode ? `/episodes/${episode.episode}` : "/";
}

export function getProjectWorkflowCurrentPhase(
  projectData: ProjectData | null | undefined,
): ProjectStatus["current_phase"] {
  return projectData?.status?.current_phase ?? (projectData?.overview ? "worldbuilding" : "setup");
}

export function getProjectWorkflowStages(projectData: ProjectData): ProjectWorkflowStage[] {
  const currentPhase = getProjectWorkflowCurrentPhase(projectData);
  const currentIndex = Math.max(0, WORKFLOW_PHASES.indexOf(currentPhase));
  const episodes = projectData.episodes ?? [];
  const summary = projectData.status?.episodes_summary;
  const assetBuckets = [
    projectData.status?.characters,
    projectData.status?.scenes,
    projectData.status?.props,
  ].filter(Boolean) as Array<{ total: number; completed: number }>;
  const assetTotal = assetBuckets.reduce((sum, item) => sum + item.total, 0);
  const assetDone = assetBuckets.reduce((sum, item) => sum + item.completed, 0);
  const scripted = summary?.scripted ?? episodes.filter((ep) => ep.script_status === "generated").length;
  const episodeTotal = summary?.total ?? episodes.length;
  const productionTotal = episodes.reduce((sum, ep) => sum + (ep.videos?.total ?? 0), 0);
  const productionDone = episodes.reduce((sum, ep) => sum + (ep.videos?.completed ?? 0), 0);
  const firstScriptTarget = episodes.find((ep) => ep.script_status !== "generated") ?? episodes[0];
  const firstProductionTarget = episodes.find((ep) => ep.status !== "completed") ?? episodes[0];
  const needsAssets = assetTotal === 0 || assetDone < assetTotal;
  const scriptingActionLabelKey =
    episodeTotal <= 0
      ? "generate_first_episode_draft"
      : firstScriptTarget?.script_status === "segmented"
        ? "generate_episode_script"
        : "workflow_action_open_script";
  const productionMode = firstProductionTarget?.generation_mode ?? projectData.generation_mode;
  const productionStoryboardTotal =
    firstProductionTarget?.storyboards?.total ?? firstProductionTarget?.scenes_count ?? 0;
  const productionStoryboardsDone = firstProductionTarget?.storyboards?.completed ?? 0;
  const productionVideoTotal = firstProductionTarget?.videos?.total ?? productionStoryboardTotal;
  const productionVideosDone = firstProductionTarget?.videos?.completed ?? 0;
  const productionStoryboardMissing = Math.max(0, productionStoryboardTotal - productionStoryboardsDone);
  const productionVideoMissing = Math.max(0, productionVideoTotal - productionVideosDone);
  const productionActionLabelKey =
    !firstProductionTarget
      ? "workflow_action_open_production"
      : productionMode === "reference_video"
        ? productionVideoTotal > productionVideosDone
          ? "workflow_action_generate_reference_videos"
          : "workflow_action_open_production"
      : productionStoryboardTotal > productionStoryboardsDone
        ? productionMode === "grid"
          ? "workflow_action_generate_grids"
          : "workflow_action_generate_storyboards"
        : productionVideoTotal > productionVideosDone
          ? "workflow_action_generate_videos"
          : "workflow_action_open_production";
  const scriptingActionDetail =
    episodeTotal <= 0
      ? { key: "workflow_detail_generate_first_draft" }
      : firstScriptTarget?.script_status === "segmented"
        ? {
          key: "workflow_detail_generate_script",
          params: { episode: firstScriptTarget.episode },
        }
        : firstScriptTarget
          ? {
            key: "workflow_detail_open_script",
            params: { episode: firstScriptTarget.episode },
          }
          : undefined;
  const productionActionDetail =
    !firstProductionTarget
      ? undefined
      : productionMode === "reference_video"
        ? {
          key: productionVideoMissing > 0
            ? "workflow_detail_generate_reference_videos"
            : "workflow_detail_open_production",
          params: { episode: firstProductionTarget.episode, count: productionVideoMissing },
        }
        : productionStoryboardMissing > 0
          ? {
            key: productionMode === "grid"
              ? "workflow_detail_generate_grids"
              : "workflow_detail_generate_storyboards",
            params: { episode: firstProductionTarget.episode, count: productionStoryboardMissing },
          }
          : productionVideoMissing > 0
            ? {
              key: "workflow_detail_generate_videos",
              params: { episode: firstProductionTarget.episode, count: productionVideoMissing },
            }
            : {
              key: "workflow_detail_open_production",
              params: { episode: firstProductionTarget.episode, count: 0 },
            };

  const stages = [
    {
      key: "setup",
      descriptionKey: projectData.overview ? "workflow_stage_setup_done" : "workflow_stage_setup_todo",
      progress: projectData.overview ? 100 : 0,
      actionLabelKey: projectData.overview ? "workflow_action_review_overview" : "workflow_action_create_overview",
      actionDetailKey: projectData.overview ? "workflow_detail_review_overview" : "workflow_detail_create_overview",
      actionPath: "/",
    },
    {
      key: "worldbuilding",
      descriptionKey:
        assetTotal > 0 ? "workflow_stage_worldbuilding_progress" : "workflow_stage_worldbuilding_todo",
      descriptionParams: assetTotal > 0 ? { done: assetDone, total: assetTotal } : undefined,
      progress: percent(assetDone, assetTotal, currentIndex > 1 ? 100 : 0),
      actionLabelKey: needsAssets ? "asset_prepare_button" : "workflow_action_manage_assets",
      actionDetailKey: needsAssets ? "workflow_detail_prepare_assets" : "workflow_detail_manage_assets",
      actionDetailParams: { count: Math.max(0, assetTotal - assetDone) },
      actionPath:
        projectData.status?.characters && projectData.status.characters.completed < projectData.status.characters.total
          ? "/characters"
          : projectData.status?.scenes && projectData.status.scenes.completed < projectData.status.scenes.total
            ? "/scenes"
            : projectData.status?.props && projectData.status.props.completed < projectData.status.props.total
              ? "/props"
              : "/characters",
    },
    {
      key: "scripting",
      descriptionKey: episodeTotal > 0 ? "workflow_stage_scripting_progress" : "workflow_stage_scripting_todo",
      descriptionParams: episodeTotal > 0 ? { done: scripted, total: episodeTotal } : undefined,
      progress: percent(scripted, episodeTotal, currentIndex > 2 ? 100 : 0),
      actionLabelKey: scriptingActionLabelKey,
      actionDetailKey: scriptingActionDetail?.key,
      actionDetailParams: scriptingActionDetail?.params,
      actionPath: episodePath(firstScriptTarget),
    },
    {
      key: "production",
      descriptionKey: productionTotal > 0 ? "workflow_stage_production_progress" : "workflow_stage_production_todo",
      descriptionParams: productionTotal > 0 ? { done: productionDone, total: productionTotal } : undefined,
      progress: percent(productionDone, productionTotal, currentIndex > 3 ? 100 : 0),
      actionLabelKey: productionActionLabelKey,
      actionDetailKey: productionActionDetail?.key,
      actionDetailParams: productionActionDetail?.params,
      actionPath: episodePath(firstProductionTarget),
    },
    {
      key: "completed",
      descriptionKey: episodeTotal > 0 ? "workflow_stage_completed_progress" : "workflow_stage_completed_todo",
      descriptionParams: episodeTotal > 0 ? { done: summary?.completed ?? 0, total: episodeTotal } : undefined,
      progress: currentPhase === "completed" ? 100 : 0,
      actionLabelKey: currentPhase === "completed" ? "workflow_action_export_project" : "workflow_action_review_project",
      actionDetailKey: currentPhase === "completed" ? "workflow_detail_export_project" : "workflow_detail_review_project",
      actionPath: "/",
    },
  ] satisfies Array<Omit<ProjectWorkflowStage, "state">>;

  return stages.map((stage, index) => ({
    ...stage,
    state: index < currentIndex ? "done" : index === currentIndex ? "current" : "todo",
  }));
}

export function getProjectWorkflowNextStage(
  projectData: ProjectData | null | undefined,
): ProjectWorkflowStage | null {
  if (!projectData) return null;
  const stages = getProjectWorkflowStages(projectData);
  return stages.find((stage) => stage.state === "current") ?? stages[0] ?? null;
}
