import { describe, expect, it } from "vitest";
import type { ProjectData } from "@/types";
import { getProjectWorkflowNextStage, getProjectWorkflowStages } from "./project-workflow";

function makeProject(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    title: "Demo",
    content_mode: "narration",
    style: "Anime",
    overview: {
      synopsis: "summary",
      genre: "fantasy",
      theme: "growth",
      world_setting: "palace",
    },
    episodes: [],
    characters: {},
    scenes: {},
    props: {},
    status: {
      current_phase: "scripting",
      phase_progress: 0,
      characters: { total: 0, completed: 0 },
      scenes: { total: 0, completed: 0 },
      props: { total: 0, completed: 0 },
      episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
    },
    ...overrides,
  };
}

function stageAction(project: ProjectData, key: string): string {
  const stage = getProjectWorkflowStages(project).find((item) => item.key === key);
  if (!stage) throw new Error(`Missing workflow stage: ${key}`);
  return stage.actionLabelKey;
}

function stageDetail(project: ProjectData, key: string) {
  const stage = getProjectWorkflowStages(project).find((item) => item.key === key);
  if (!stage) throw new Error(`Missing workflow stage: ${key}`);
  return {
    key: stage.actionDetailKey,
    params: stage.actionDetailParams,
  };
}

describe("project workflow", () => {
  it("generates a first episode draft when scripting has no episodes", () => {
    expect(stageAction(makeProject(), "scripting")).toBe("generate_first_episode_draft");
  });

  it("generates a script when the next episode has a segmented draft", () => {
    const project = makeProject({
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "segmented",
          status: "draft",
        },
      ],
      status: {
        current_phase: "scripting",
        phase_progress: 0,
        characters: { total: 0, completed: 0 },
        scenes: { total: 0, completed: 0 },
        props: { total: 0, completed: 0 },
        episodes_summary: { total: 1, scripted: 0, in_production: 0, completed: 0 },
      },
    });

    expect(stageAction(project, "scripting")).toBe("generate_episode_script");
    expect(stageDetail(project, "scripting")).toEqual({
      key: "workflow_detail_generate_script",
      params: { episode: 1 },
    });
  });

  it("describes the next scripting target episode", () => {
    expect(
      stageDetail(
        makeProject({
          episodes: [
            {
              episode: 2,
              title: "EP2",
              script_file: "scripts/episode_2.json",
              script_status: "segmented",
              status: "draft",
            },
          ],
          status: {
            current_phase: "scripting",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 1, scripted: 0, in_production: 0, completed: 0 },
          },
        }),
        "scripting",
      ),
    ).toEqual({
      key: "workflow_detail_generate_script",
      params: { episode: 2 },
    });
  });

  it("prioritizes missing storyboards before videos in production", () => {
    const project = makeProject({
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "generated",
          status: "scripted",
          storyboards: { total: 2, completed: 1 },
          videos: { total: 2, completed: 0 },
        },
      ],
      status: {
        current_phase: "production",
        phase_progress: 0,
        characters: { total: 0, completed: 0 },
        scenes: { total: 0, completed: 0 },
        props: { total: 0, completed: 0 },
        episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
      },
    });

    expect(getProjectWorkflowNextStage(project)?.actionLabelKey).toBe("workflow_action_generate_storyboards");
    expect(stageDetail(project, "production")).toEqual({
      key: "workflow_detail_generate_storyboards",
      params: { episode: 1, count: 1 },
    });
  });

  it("uses grid generation for grid production when storyboards are missing", () => {
    expect(
      stageAction(
        makeProject({
          generation_mode: "grid",
          episodes: [
            {
              episode: 1,
              title: "EP1",
              script_file: "scripts/episode_1.json",
              script_status: "generated",
              status: "scripted",
              generation_mode: "grid",
              storyboards: { total: 2, completed: 0 },
              videos: { total: 2, completed: 0 },
            },
          ],
          status: {
            current_phase: "production",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
        }),
        "production",
      ),
    ).toBe("workflow_action_generate_grids");
  });

  it("generates videos once storyboards are complete", () => {
    expect(
      stageAction(
        makeProject({
          episodes: [
            {
              episode: 1,
              title: "EP1",
              script_file: "scripts/episode_1.json",
              script_status: "generated",
              status: "in_production",
              storyboards: { total: 2, completed: 2 },
              videos: { total: 2, completed: 1 },
            },
          ],
          status: {
            current_phase: "production",
            phase_progress: 0.5,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
        }),
        "production",
      ),
    ).toBe("workflow_action_generate_videos");
  });

  it("uses reference video generation for reference-video production", () => {
    const project = makeProject({
      generation_mode: "reference_video",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "generated",
          status: "in_production",
          generation_mode: "reference_video",
          videos: { total: 2, completed: 1 },
        },
      ],
      status: {
        current_phase: "production",
        phase_progress: 0,
        characters: { total: 0, completed: 0 },
        scenes: { total: 0, completed: 0 },
        props: { total: 0, completed: 0 },
        episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
      },
    });

    expect(stageAction(project, "production")).toBe("workflow_action_generate_reference_videos");
    expect(stageDetail(project, "production")).toEqual({
      key: "workflow_detail_generate_reference_videos",
      params: { episode: 1, count: 1 },
    });
  });

  it("exports the project when the workflow is completed", () => {
    const project = makeProject({
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "generated",
          status: "completed",
          videos: { total: 1, completed: 1 },
        },
      ],
      status: {
        current_phase: "completed",
        phase_progress: 1,
        characters: { total: 0, completed: 0 },
        scenes: { total: 0, completed: 0 },
        props: { total: 0, completed: 0 },
        episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 1 },
      },
    });

    expect(getProjectWorkflowNextStage(project)?.actionLabelKey).toBe("workflow_action_export_project");
    expect(stageDetail(project, "completed")).toEqual({
      key: "workflow_detail_export_project",
      params: undefined,
    });
  });
});
