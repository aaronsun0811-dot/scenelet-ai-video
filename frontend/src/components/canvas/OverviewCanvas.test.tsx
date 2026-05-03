import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { OverviewCanvas } from "./OverviewCanvas";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import { makeTask } from "@/test/factories";
import type { EpisodeScript, ProjectData, ReferenceVideoUnit } from "@/types";

vi.mock("./WelcomeCanvas", () => ({
  WelcomeCanvas: (props: { quickStartActive?: boolean; quickStartProgress?: ReactNode }) => (
    <div data-testid="welcome-canvas" data-quickstart={props.quickStartActive ? "true" : "false"}>
      welcome
      {props.quickStartProgress}
    </div>
  ),
}));

function makeProjectData(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    title: "Demo",
    content_mode: "narration",
    style: "Anime",
    style_description: "old description",
    overview: {
      synopsis: "summary",
      genre: "fantasy",
      theme: "growth",
      world_setting: "palace",
    },
    episodes: [{ episode: 1, title: "EP1", script_file: "scripts/episode_1.json" }],
    characters: {},
    scenes: {},
    props: {},
    ...overrides,
  };
}

function makeEpisodeScript(overrides: Partial<EpisodeScript> = {}): EpisodeScript {
  return {
    episode: 1,
    title: "EP1",
    content_mode: "narration",
    duration_seconds: 4,
    summary: "summary",
    novel: { title: "Demo", chapter: "1" },
    segments: [],
    ...overrides,
  } as EpisodeScript;
}

function makeReferenceVideoUnit(overrides: Partial<ReferenceVideoUnit> = {}): ReferenceVideoUnit {
  const generatedAssets: ReferenceVideoUnit["generated_assets"] = {
    storyboard_image: null,
    storyboard_last_image: null,
    grid_id: null,
    grid_cell_index: null,
    video_clip: null,
    video_uri: null,
    status: "pending",
    ...overrides.generated_assets,
  };
  return {
    unit_id: "E1U1",
    shots: [{ duration: 4, text: "shot" }],
    references: [],
    duration_seconds: 4,
    duration_override: false,
    transition_to_next: "cut",
    note: null,
    ...overrides,
    generated_assets: generatedAssets,
  };
}

describe("OverviewCanvas", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useTasksStore.setState(useTasksStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.stubGlobal("confirm", vi.fn(() => true));
    window.history.pushState(null, "", "/");
  });

  it("renders the project title and content mode", () => {
    render(<OverviewCanvas projectName="demo" projectData={makeProjectData()} />);
    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("renders a project workflow panel with stage actions", () => {
    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          status: {
            current_phase: "production",
            phase_progress: 0.5,
            characters: { total: 2, completed: 1 },
            scenes: { total: 1, completed: 1 },
            props: { total: 1, completed: 0 },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
          episodes: [
            {
              episode: 1,
              title: "EP1",
              script_file: "scripts/episode_1.json",
              script_status: "generated",
              status: "in_production",
              videos: { total: 2, completed: 1 },
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("制作工作流")).toBeInTheDocument();
    expect(screen.getByText("分镜与视频")).toBeInTheDocument();
    expect(screen.getByText("已完成 1 / 2 个视频片段。")).toBeInTheDocument();
    expect(screen.getByText("第 1 集还有 1 个视频可提交生成。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /生成可生成视频|Generate Ready Videos/ }).length).toBeGreaterThan(0);
  });

  it("runs the workflow next action for an empty scripting stage", async () => {
    const projectWithEpisode = makeProjectData({
      episodes: [{ episode: 1, title: "第 1 集", script_file: "scripts/episode_1.json" }],
    });
    vi.spyOn(API, "generateEpisodeDraft").mockResolvedValue({
      success: true,
      episode: 1,
      title: "第 1 集",
      script_file: "scripts/episode_1.json",
      draft_path: "drafts/episode_1/step1_segments.md",
      content: "# draft",
      source: "source",
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: projectWithEpisode,
      scripts: {},
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [],
            status: {
              current_phase: "scripting",
              phase_progress: 0,
              characters: { total: 0, completed: 0 },
              scenes: { total: 0, completed: 0 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成第 1 集草稿|Next: Generate Episode 1 Draft/ }));

    await waitFor(() => {
      expect(API.generateEpisodeDraft).toHaveBeenCalledWith("demo", 1);
      expect(location.history?.at(-1)).toBe("/episodes/1");
    });
  }, 10_000);

  it("runs the workflow next action to generate a script from a segmented draft", async () => {
    const generatedScript = makeEpisodeScript();
    const projectWithGeneratedScript = makeProjectData({
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "generated",
          status: "scripted",
        },
      ],
    });
    vi.spyOn(API, "generateEpisodeScript").mockResolvedValue({
      success: true,
      episode: 1,
      script_file: "scripts/episode_1.json",
      script: generatedScript,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: projectWithGeneratedScript,
      scripts: { "scripts/episode_1.json": generatedScript },
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成剧本|Next: Generate Script/ }));

    await waitFor(() => {
      expect(API.generateEpisodeScript).toHaveBeenCalledWith("demo", 1);
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("第 1 集剧本已生成");
    });
  }, 10_000);

  it("runs the workflow next action to submit missing storyboards for production", async () => {
    const script = makeEpisodeScript({
      segments: [
        {
          segment_id: "SEG-1",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt",
          video_prompt: "video prompt",
          transition_to_next: "cut",
        },
      ],
    });
    useProjectsStore.setState({ currentScripts: { "scripts/episode_1.json": script } });
    vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-1",
      message: "ok",
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "generated",
                status: "scripted",
                storyboards: { total: 1, completed: 0 },
                videos: { total: 1, completed: 0 },
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成缺失分镜|Next: Generate Missing Storyboards/ }));

    await waitFor(() => {
      expect(API.generateStoryboard).toHaveBeenCalledWith(
        "demo",
        "SEG-1",
        "image prompt",
        "episode_1.json",
      );
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("已提交 1 个分镜生成任务");
    });
  }, 10_000);

  it("shows project delivery checks and handles the next missing episode output", async () => {
    const script = makeEpisodeScript({
      segments: [
        {
          segment_id: "SEG-1",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 1",
          video_prompt: "video prompt 1",
          transition_to_next: "cut",
          generated_assets: {
            storyboard_image: "storyboards/scene_SEG-1.png",
            storyboard_last_image: null,
            grid_id: null,
            grid_cell_index: null,
            video_clip: "videos/scene_SEG-1.mp4",
            video_thumbnail: "thumbnails/scene_SEG-1.jpg",
            video_uri: null,
            status: "completed",
          },
        },
        {
          segment_id: "SEG-2",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 2",
          video_prompt: "video prompt 2",
          transition_to_next: "cut",
          generated_assets: {
            storyboard_image: "storyboards/scene_SEG-2.png",
            storyboard_last_image: null,
            grid_id: null,
            grid_cell_index: null,
            video_clip: null,
            video_thumbnail: null,
            video_uri: null,
            status: "storyboard_ready",
          },
        },
      ],
    });
    useProjectsStore.setState({ currentScripts: { "episode_1.json": script } });
    vi.spyOn(API, "generateVideo").mockResolvedValue({
      success: true,
      task_id: "video-2",
      message: "ok",
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
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
              phase_progress: 0,
              characters: { total: 0, completed: 0 },
              scenes: { total: 0, completed: 0 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
            },
          })}
        />
      </Router>,
    );

    expect(screen.getByText("项目交付总检查")).toBeInTheDocument();
    expect(screen.getByText(/优先处理第 1 集/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /处理下一项|Handle Next Item/ }));

    await waitFor(() => {
      expect(API.generateVideo).toHaveBeenCalledWith(
        "demo",
        "SEG-2",
        "video prompt 2",
        "episode_1.json",
        4,
      );
      expect(location.history?.at(-1)).toBe("/episodes/1");
    });
  }, 10_000);

  it("does not resubmit active storyboard tasks from the overview workflow", async () => {
    const script = makeEpisodeScript({
      segments: [
        {
          segment_id: "SEG-1",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 1",
          video_prompt: "video prompt 1",
          transition_to_next: "cut",
        },
        {
          segment_id: "SEG-2",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 2",
          video_prompt: "video prompt 2",
          transition_to_next: "cut",
        },
      ],
    });
    useProjectsStore.setState({ currentScripts: { "scripts/episode_1.json": script } });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-1",
          script_file: "episode_1.json",
          status: "queued",
        }),
      ],
    });
    vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-2",
      message: "ok",
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "generated",
                status: "scripted",
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成缺失分镜|Next: Generate Missing Storyboards/ }));

    await waitFor(() => {
      expect(API.generateStoryboard).toHaveBeenCalledTimes(1);
      expect(API.generateStoryboard).toHaveBeenCalledWith(
        "demo",
        "SEG-2",
        "image prompt 2",
        "episode_1.json",
      );
      expect(location.history?.at(-1)).toBe("/episodes/1");
    });
  }, 10_000);

  it("does not resubmit active grid tasks from the overview workflow", async () => {
    const script = makeEpisodeScript({
      segments: [
        {
          segment_id: "SEG-1",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt",
          video_prompt: "video prompt",
          transition_to_next: "cut",
        },
      ],
    });
    useProjectsStore.setState({ currentScripts: { "episode_1.json": script } });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "grid",
          media_type: "image",
          resource_id: "grid_1",
          script_file: "scripts/episode_1.json",
          status: "queued",
        }),
      ],
    });
    const generateGridSpy = vi.spyOn(API, "generateGrid").mockResolvedValue({
      success: true,
      grid_ids: ["grid_2"],
      task_ids: ["grid-task-2"],
      message: "ok",
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            generation_mode: "grid",
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "generated",
                status: "scripted",
                generation_mode: "grid",
                storyboards: { total: 1, completed: 0 },
                videos: { total: 1, completed: 0 },
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成网格分镜|Next: Generate Grid Storyboards/ }));

    await waitFor(() => {
      expect(generateGridSpy).not.toHaveBeenCalled();
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("宫格任务已在队列中");
    });
  }, 10_000);

  it("tells the user when overview production work is already queued", async () => {
    const script = makeEpisodeScript({
      segments: [
        {
          segment_id: "SEG-1",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 1",
          video_prompt: "video prompt 1",
          transition_to_next: "cut",
        },
      ],
    });
    useProjectsStore.setState({ currentScripts: { "episode_1.json": script } });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-1",
          script_file: "scripts/episode_1.json",
          status: "running",
        }),
      ],
    });
    const generateSpy = vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-1",
      message: "ok",
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "generated",
                status: "scripted",
                storyboards: { total: 1, completed: 0 },
                videos: { total: 1, completed: 0 },
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成缺失分镜|Next: Generate Missing Storyboards/ }));

    await waitFor(() => {
      expect(generateSpy).not.toHaveBeenCalled();
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("已在队列中");
    });
  }, 10_000);

  it("runs the workflow next action to submit missing reference videos", async () => {
    vi.spyOn(API, "listReferenceVideoUnits").mockResolvedValue({
      units: [
        makeReferenceVideoUnit({ unit_id: "E1U1" }),
        makeReferenceVideoUnit({
          unit_id: "E1U2",
          generated_assets: {
            storyboard_image: null,
            storyboard_last_image: null,
            grid_id: null,
            grid_cell_index: null,
            video_clip: "reference_videos/E1U2.mp4",
            video_uri: null,
            status: "completed",
          },
        }),
      ],
    });
    vi.spyOn(API, "generateReferenceVideoUnit").mockResolvedValue({
      task_id: "reference-1",
      deduped: false,
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成参考视频|Next: Generate Reference Videos/ }));

    await waitFor(() => {
      expect(API.listReferenceVideoUnits).toHaveBeenCalledWith("demo", 1);
      expect(API.generateReferenceVideoUnit).toHaveBeenCalledTimes(1);
      expect(API.generateReferenceVideoUnit).toHaveBeenCalledWith("demo", 1, "E1U1");
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("已提交 1 个参考视频任务");
    });
  }, 10_000);

  it("tells the user when reference-video workflow work is already queued", async () => {
    vi.spyOn(API, "listReferenceVideoUnits").mockResolvedValue({
      units: [makeReferenceVideoUnit({ unit_id: "E1U1" })],
    });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "reference_video",
          media_type: "video",
          resource_id: "E1U1",
          status: "running",
        }),
      ],
    });
    const generateSpy = vi.spyOn(API, "generateReferenceVideoUnit").mockResolvedValue({
      task_id: "reference-1",
      deduped: false,
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            generation_mode: "reference_video",
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "generated",
                status: "in_production",
                generation_mode: "reference_video",
                videos: { total: 1, completed: 0 },
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
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：生成参考视频|Next: Generate Reference Videos/ }));

    await waitFor(() => {
      expect(generateSpy).not.toHaveBeenCalled();
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("已在队列中");
    });
  }, 10_000);

  it("runs the workflow next action to export a completed project", async () => {
    vi.spyOn(API, "requestExportToken").mockResolvedValue({
      download_token: "download-token",
      expires_in: 300,
      diagnostics: {
        blocking: [],
        auto_fixed: [],
        warnings: [],
      },
      delivery_report: null,
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
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
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：导出项目 ZIP|Next: Export Project ZIP/ }));

    await waitFor(() => {
      expect(API.requestExportToken).toHaveBeenCalledWith("demo", "current");
      expect(anchorClick).toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("项目 ZIP 已开始下载");
    });
  }, 10_000);

  it("opens the backend delivery report from the project delivery panel without downloading", async () => {
    const requestExportToken = vi.spyOn(API, "requestExportToken");
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: {
        blocking: [],
        auto_fixed: [],
        warnings: [],
      },
      delivery_report: {
        format_version: 1,
        status: "needs_work",
        generated_at: "2026-05-02T00:00:00+08:00",
        totals: {
          episodes: 2,
          ready_episodes: 1,
          scripts_ready: 2,
          storyboards_ready: 1,
          storyboards_total: 2,
          videos_ready: 1,
          videos_total: 2,
          blocking_issues: 1,
          warnings: 0,
        },
        episodes: [
          {
            episode: 1,
            title: "EP1",
            script_file: "scripts/episode_1.json",
            script_ready: true,
            status: "ready",
            storyboards: { ready: 1, total: 1, missing: [] },
            videos: { ready: 1, total: 1, missing: [] },
            blocking_issues: [],
            warnings: [],
          },
          {
            episode: 2,
            title: "EP2",
            script_file: "scripts/episode_2.json",
            script_ready: true,
            status: "needs_work",
            storyboards: { ready: 0, total: 1, missing: ["E2S01"] },
            videos: { ready: 0, total: 1, missing: ["E2S01"] },
            blocking_issues: [
              { code: "missing_videos", message: "1 个视频未生成", items: ["E2S01"] },
            ],
            warnings: [],
          },
        ],
      },
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "generated",
                status: "completed",
                storyboards: { total: 1, completed: 1 },
                videos: { total: 1, completed: 1 },
              },
              {
                episode: 2,
                title: "EP2",
                script_file: "scripts/episode_2.json",
                script_status: "generated",
                status: "completed",
                storyboards: { total: 1, completed: 1 },
                videos: { total: 1, completed: 1 },
              },
            ],
            status: {
              current_phase: "completed",
              phase_progress: 1,
              characters: { total: 0, completed: 0 },
              scenes: { total: 0, completed: 0 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 2, scripted: 2, in_production: 0, completed: 2 },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /查看交付报告|View Delivery Report/ }));

    expect(await screen.findByText("后端交付报告")).toBeInTheDocument();
    expect(screen.getByText("本集交付检查通过")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 MD" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 JSON" })).toBeInTheDocument();
    expect(screen.getByText("1 个视频未生成")).toBeInTheDocument();
    expect(screen.getByText("分镜/宫格 1/1 · 视频 1/1")).toBeInTheDocument();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(requestExportToken).not.toHaveBeenCalled();
    expect(API.requestExportPreflight).toHaveBeenCalledWith("demo", "current");

    fireEvent.click(screen.getByRole("button", { name: /去处理|Go Fix/ }));

    expect(location.history?.at(-1)).toBe("/episodes/2");
  }, 10_000);

  it("uses the backend delivery report to confirm before starting a risky export", async () => {
    vi.spyOn(API, "requestExportToken").mockResolvedValue({
      download_token: "download-token",
      expires_in: 300,
      diagnostics: {
        blocking: [],
        auto_fixed: [],
        warnings: [],
      },
      delivery_report: {
        format_version: 1,
        status: "needs_work",
        generated_at: "2026-05-02T00:00:00+08:00",
        totals: {
          episodes: 1,
          ready_episodes: 0,
          scripts_ready: 1,
          storyboards_ready: 1,
          storyboards_total: 1,
          videos_ready: 0,
          videos_total: 1,
          blocking_issues: 1,
          warnings: 0,
        },
        episodes: [
          {
            episode: 1,
            title: "EP1",
            script_file: "scripts/episode_1.json",
            script_ready: true,
            status: "needs_work",
            storyboards: { ready: 1, total: 1, missing: [] },
            videos: { ready: 0, total: 1, missing: ["E1S01"] },
            blocking_issues: [
              { code: "missing_videos", message: "1 个视频未生成", items: ["E1S01"] },
            ],
            warnings: [],
          },
        ],
      },
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
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
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：导出项目 ZIP|Next: Export Project ZIP/ }));

    expect(await screen.findByText("导出前检查")).toBeInTheDocument();
    expect(screen.getByText("1 个视频未生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /去处理|Go Fix/ })).toBeInTheDocument();
    expect(anchorClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /仍然导出|Export Anyway/ }));

    await waitFor(() => {
      expect(anchorClick).toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("检查提醒");
    });
  }, 10_000);

  it("shows a pre-export confirmation when delivery checks still have blockers", async () => {
    const script = makeEpisodeScript({
      segments: [
        {
          segment_id: "SEG-1",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 1",
          video_prompt: "video prompt 1",
          transition_to_next: "cut",
          generated_assets: {
            storyboard_image: "storyboards/scene_SEG-1.png",
            storyboard_last_image: null,
            grid_id: null,
            grid_cell_index: null,
            video_clip: "videos/scene_SEG-1.mp4",
            video_thumbnail: "thumbnails/scene_SEG-1.jpg",
            video_uri: null,
            status: "completed",
          },
        },
        {
          segment_id: "SEG-2",
          episode: 1,
          duration_seconds: 4,
          segment_break: false,
          novel_text: "text",
          characters_in_segment: [],
          image_prompt: "image prompt 2",
          video_prompt: "video prompt 2",
          transition_to_next: "cut",
          generated_assets: {
            storyboard_image: "storyboards/scene_SEG-2.png",
            storyboard_last_image: null,
            grid_id: null,
            grid_cell_index: null,
            video_clip: null,
            video_thumbnail: null,
            video_uri: null,
            status: "storyboard_ready",
          },
        },
      ],
    });
    useProjectsStore.setState({ currentScripts: { "scripts/episode_1.json": script } });
    vi.spyOn(API, "requestExportToken").mockResolvedValue({
      download_token: "download-token",
      expires_in: 300,
      diagnostics: {
        blocking: [],
        auto_fixed: [],
        warnings: [],
      },
      delivery_report: {
        format_version: 1,
        status: "needs_work",
        generated_at: "2026-05-02T00:00:00+08:00",
        totals: {
          episodes: 1,
          ready_episodes: 0,
          scripts_ready: 1,
          storyboards_ready: 2,
          storyboards_total: 2,
          videos_ready: 1,
          videos_total: 2,
          blocking_issues: 1,
          warnings: 0,
        },
        episodes: [
          {
            episode: 1,
            title: "EP1",
            script_file: "scripts/episode_1.json",
            script_ready: true,
            status: "needs_work",
            storyboards: { ready: 2, total: 2, missing: [] },
            videos: { ready: 1, total: 2, missing: ["SEG-2"] },
            blocking_issues: [
              { code: "missing_videos", message: "1 个视频未生成", items: ["SEG-2"] },
            ],
            warnings: [],
          },
        ],
      },
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          episodes: [
            {
              episode: 1,
              title: "EP1",
              script_file: "scripts/episode_1.json",
              script_status: "generated",
              status: "completed",
              storyboards: { total: 2, completed: 2 },
              videos: { total: 2, completed: 1 },
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
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下一步：导出项目 ZIP|Next: Export Project ZIP/ }));

    expect(await screen.findByText("导出前检查")).toBeInTheDocument();
    expect(screen.getByText("视频未齐 1/2")).toBeInTheDocument();
    expect(API.requestExportToken).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /仍然导出|Export Anyway/ }));

    await waitFor(() => {
      expect(API.requestExportToken).toHaveBeenCalledWith("demo", "current");
      expect(anchorClick).toHaveBeenCalled();
    });
    expect(await screen.findByText("导出包交付报告")).toBeInTheDocument();
    expect(screen.getByText("1 个视频未生成")).toBeInTheDocument();
  }, 10_000);

  it("opens an episode from the overview list and shows its next action", () => {
    const location = memoryLocation({ path: "/", record: true });
    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [
              {
                episode: 1,
                title: "EP1",
                script_file: "scripts/episode_1.json",
                script_status: "segmented",
                status: "draft",
              },
            ],
          })}
        />
      </Router>,
    );

    expect(screen.getByText(/下一步：生成剧本|Next: Generate Script/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /打开第 1 集|Open episode 1/ }));
    expect(location.history?.at(-1)).toBe("/episodes/1");
  });

  it("renders content-type workflow guidance when a project has content_type", () => {
    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({ content_type: "scene_sketch" })}
      />,
    );

    expect(screen.getByText("内容工作流")).toBeInTheDocument();
    expect(screen.getByText("情景剧工作流")).toBeInTheDocument();
    expect(screen.getByText("横屏 16:9")).toBeInTheDocument();
    expect(screen.getByText("图生视频")).toBeInTheDocument();
    expect(screen.getByText("保留多轮对话、停顿、反应和走位。")).toBeInTheDocument();
  });

  it("uses content_type as the effective overview mode for legacy inconsistent projects", () => {
    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({ content_type: "scene_sketch", content_mode: "narration" })}
      />,
    );

    expect(screen.getAllByText("剧集模式")).toHaveLength(2);
    expect(screen.queryByText("旁白模式")).not.toBeInTheDocument();
  });

  it("shows welcome canvas when there is no overview and no episodes", () => {
    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({ overview: undefined, episodes: [] })}
      />,
    );
    expect(screen.getByTestId("welcome-canvas")).toBeInTheDocument();
  });

  it("passes the create-project quickstart guide into the welcome canvas", () => {
    window.history.pushState(null, "", "/app/projects/demo?workflow=quickstart");

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({ overview: undefined, episodes: [] })}
      />,
    );

    expect(screen.getByTestId("welcome-canvas")).toHaveAttribute("data-quickstart", "true");
  });

  it("regenerates overview on button click", async () => {
    vi.spyOn(API, "generateOverview").mockResolvedValue(undefined as never);
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: {},
    });

    render(<OverviewCanvas projectName="demo" projectData={makeProjectData()} />);

    // Find the regenerate button by its accessible role
    const buttons = screen.getAllByRole("button");
    const regenButton = buttons.find((b) => b.getAttribute("title") !== null);
    if (regenButton) {
      regenButton.click();
      await waitFor(() => {
        expect(API.generateOverview).toHaveBeenCalledWith("demo");
      });
    }
  }, 10_000);

  it("runs one-click asset preparation from overview", async () => {
    const preparedProject = makeProjectData({
      characters: { Hero: { description: "hero" } },
      scenes: { Office: { description: "office" } },
      props: { Contract: { description: "contract" } },
    });
    vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: preparedProject.characters,
      source: "source",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: preparedProject.scenes ?? {},
      source: "source",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: preparedProject.props ?? {},
      source: "source",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: preparedProject,
      scripts: {},
    });
    vi.spyOn(API, "generateCharacter").mockResolvedValue({ success: true, task_id: "c-1", message: "ok" });
    vi.spyOn(API, "generateProjectScene").mockResolvedValue({ success: true, task_id: "s-1", message: "ok" });
    vi.spyOn(API, "generateProjectProp").mockResolvedValue({ success: true, task_id: "p-1", message: "ok" });

    render(<OverviewCanvas projectName="demo" projectData={makeProjectData()} />);

    const assetButtons = screen.getAllByRole("button", { name: /一键准备资产|Prepare Assets/ });
    const assetButton = assetButtons.find((button) => !button.textContent?.match(/下一步|Next/));
    expect(assetButton).toBeDefined();
    fireEvent.click(assetButton!);

    await waitFor(() => {
      expect(API.generateProjectCharacters).toHaveBeenCalledWith("demo");
      expect(API.generateProjectScenes).toHaveBeenCalledWith("demo");
      expect(API.generateProjectProps).toHaveBeenCalledWith("demo");
      expect(API.generateCharacter).toHaveBeenCalledWith("demo", "Hero", "hero");
      expect(API.generateProjectScene).toHaveBeenCalledWith("demo", "Office", "office");
      expect(API.generateProjectProp).toHaveBeenCalledWith("demo", "Contract", "contract");
      expect(useAppStore.getState().toast?.text).toContain("资产准备完成");
    });
    expect(await screen.findByText("资产准备完成：生成/补全 3 项，提交 3 个设定图任务，失败 0 个。")).toBeInTheDocument();
  }, 10_000);

  it("shows an inline retry action when one-click asset preparation fails", async () => {
    const preparedProject = makeProjectData({
      characters: { Hero: { description: "hero" } },
      scenes: { Office: { description: "office" } },
      props: { Contract: { description: "contract" } },
    });
    vi.spyOn(API, "generateProjectCharacters")
      .mockRejectedValueOnce(new Error("list boom"))
      .mockResolvedValueOnce({
        success: true,
        characters: preparedProject.characters,
        source: "source",
        added: 1,
        updated: 0,
        skipped: 0,
      });
    vi.spyOn(API, "generateProjectScenes")
      .mockRejectedValueOnce(new Error("list boom"))
      .mockResolvedValueOnce({
        success: true,
        scenes: preparedProject.scenes ?? {},
        source: "source",
        added: 1,
        updated: 0,
        skipped: 0,
      });
    vi.spyOn(API, "generateProjectProps")
      .mockRejectedValueOnce(new Error("list boom"))
      .mockResolvedValueOnce({
        success: true,
        props: preparedProject.props ?? {},
        source: "source",
        added: 1,
        updated: 0,
        skipped: 0,
      });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: preparedProject,
      scripts: {},
    });

    render(<OverviewCanvas projectName="demo" projectData={makeProjectData()} />);

    fireEvent.click(screen.getByRole("button", { name: /只补清单|Lists Only/ }));

    expect(await screen.findByText("资产准备失败：list boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^重试$|^Retry$/ }));

    await waitFor(() => {
      expect(API.generateProjectCharacters).toHaveBeenCalledTimes(2);
      expect(API.generateProjectScenes).toHaveBeenCalledTimes(2);
      expect(API.generateProjectProps).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("资产清单已补全：生成/补全 3 项，失败 0 个。")).toBeInTheDocument();
  }, 10_000);

  it("runs the one-click kickoff chain to the first episode draft", async () => {
    const refreshedProject = makeProjectData({
      episodes: [],
      characters: { Hero: { description: "hero" } },
      scenes: { Office: { description: "office" } },
      props: { Contract: { description: "contract" } },
      status: {
        current_phase: "scripting",
        phase_progress: 0,
        characters: { total: 1, completed: 0 },
        scenes: { total: 1, completed: 0 },
        props: { total: 1, completed: 0 },
        episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
      },
    });
    vi.spyOn(API, "generateOverview").mockResolvedValue({ success: true, overview: refreshedProject.overview! });
    vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: refreshedProject.characters,
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: refreshedProject.scenes ?? {},
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: refreshedProject.props ?? {},
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateEpisodeDraft").mockResolvedValue({
      success: true,
      episode: 1,
      title: "第 1 集",
      script_file: "scripts/episode_1.json",
      draft_path: "drafts/episode_1/step1_segments.md",
      content: "# draft",
      source: "overview",
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: refreshedProject,
      scripts: {},
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [],
            status: {
              current_phase: "scripting",
              phase_progress: 0,
              characters: { total: 0, completed: 0 },
              scenes: { total: 0, completed: 0 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /一键起步|One-click kickoff/ }));

    await waitFor(() => {
      expect(API.generateOverview).not.toHaveBeenCalled();
      expect(API.generateProjectCharacters).toHaveBeenCalledWith("demo");
      expect(API.generateProjectScenes).toHaveBeenCalledWith("demo");
      expect(API.generateProjectProps).toHaveBeenCalledWith("demo");
      expect(API.generateEpisodeDraft).toHaveBeenCalledWith("demo", 1);
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("一键起步完成");
    });
  }, 10_000);

  it("uses the content-type quickstart plan for travel videos", async () => {
    const afterLists = makeProjectData({
      content_type: "travel_video",
      content_mode: "narration",
      generation_mode: "reference_video",
      travel_video_settings: {
        origin: "大阪难波站",
        destination: "黑门市场",
        route_source: "google_street_view",
        reference_images: ["travel_references/osaka-map.png"],
      },
      episodes: [],
      scenes: { "大阪路线": { description: "route" } },
    });
    const afterDraft = makeProjectData({
      content_type: "travel_video",
      content_mode: "narration",
      generation_mode: "reference_video",
      travel_video_settings: {
        origin: "大阪难波站",
        destination: "黑门市场",
        route_source: "google_street_view",
        reference_images: ["travel_references/osaka-map.png"],
      },
      episodes: [
        {
          episode: 1,
          title: "第 1 集",
          script_file: "scripts/episode_1.json",
          script_status: "segmented",
          status: "draft",
          generation_mode: "reference_video",
        },
      ],
    });
    const afterScript = makeProjectData({
      content_type: "travel_video",
      content_mode: "narration",
      generation_mode: "reference_video",
      travel_video_settings: {
        origin: "大阪难波站",
        destination: "黑门市场",
        route_source: "google_street_view",
        reference_images: ["travel_references/osaka-map.png"],
      },
      episodes: [
        {
          episode: 1,
          title: "第 1 集",
          script_file: "scripts/episode_1.json",
          script_status: "generated",
          status: "scripted",
          generation_mode: "reference_video",
          videos: { total: 1, completed: 0 },
        },
      ],
    });
    const charactersSpy = vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: {},
      source: "overview",
      added: 0,
      updated: 0,
      skipped: 0,
    });
    const scenesSpy = vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: afterLists.scenes ?? {},
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    const propsSpy = vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: {},
      source: "overview",
      added: 0,
      updated: 0,
      skipped: 0,
    });
    const routePreviewSpy = vi.spyOn(API, "previewTravelRoute").mockResolvedValue({
      source: "google",
      google_configured: true,
      route_ready: true,
      origin: "大阪难波站",
      destination: "黑门市场",
      summary: "大阪难波站 -> 黑门市场",
      distance_text: "1.2 km",
      duration_text: "15 mins",
      nodes: [],
      reference_images: ["travel_references/osaka-map.png"],
      warnings: [],
      generated_at: "2026-05-02T00:00:00+08:00",
    });
    const addReferenceAssetSpy = vi.spyOn(API, "addAssetFromProjectFile").mockResolvedValue({
      asset: {
        id: "scene-osaka-map",
        type: "scene",
        name: "osaka-map",
        description: "旅游路线参考图：travel_references/osaka-map.png",
        voice_style: "",
        image_path: "_global_assets/scene/osaka-map.png",
        source_project: "demo",
        updated_at: "2026-05-02T00:00:00+08:00",
      },
    });
    vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [{ id: "scene-osaka-map", name: "osaka-map" }],
      skipped: [],
      failed: [],
    });
    vi.spyOn(API, "generateEpisodeDraft").mockResolvedValue({
      success: true,
      episode: 1,
      title: "第 1 集",
      script_file: "scripts/episode_1.json",
      draft_path: "drafts/episode_1/step1_segments.md",
      content: "# draft",
      source: "overview",
    });
    vi.spyOn(API, "generateEpisodeScript").mockResolvedValue({
      success: true,
      episode: 1,
      script_file: "scripts/episode_1.json",
      script: makeEpisodeScript(),
    });
    vi.spyOn(API, "listReferenceVideoUnits").mockResolvedValue({
      units: [makeReferenceVideoUnit({ unit_id: "E1U1" })],
    });
    vi.spyOn(API, "generateReferenceVideoUnit").mockResolvedValue({
      task_id: "reference-1",
      deduped: false,
    });
    vi.spyOn(API, "getProject")
      .mockResolvedValueOnce({ project: afterLists, scripts: {} })
      .mockResolvedValueOnce({ project: afterLists, scripts: {} })
      .mockResolvedValueOnce({ project: afterDraft, scripts: {} })
      .mockResolvedValueOnce({ project: afterDraft, scripts: {} })
      .mockResolvedValueOnce({ project: afterScript, scripts: {} })
      .mockResolvedValueOnce({ project: afterScript, scripts: {} });
    const location = memoryLocation({ path: "/", record: true });
    window.history.pushState(null, "", "/app/projects/demo?workflow=quickstart");

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            content_type: "travel_video",
            content_mode: "narration",
            generation_mode: "reference_video",
            travel_video_settings: {
              origin: "大阪难波站",
              destination: "黑门市场",
              route_source: "google_street_view",
              reference_images: ["travel_references/osaka-map.png"],
            },
            episodes: [],
            status: {
              current_phase: "scripting",
              phase_progress: 0,
              characters: { total: 0, completed: 0 },
              scenes: { total: 0, completed: 0 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
            },
          })}
        />
      </Router>,
    );

    expect(screen.getByText("补路线场景")).toBeInTheDocument();
    expect(screen.getByText("提交参考视频")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /一键起步|One-click kickoff/ })[0]);

    await waitFor(() => {
      expect(routePreviewSpy).toHaveBeenCalledWith(
        "demo",
        {
          origin: "大阪难波站",
          destination: "黑门市场",
          route_source: "google_street_view",
          reference_images: ["travel_references/osaka-map.png"],
        },
        { persist: true },
      );
      expect(addReferenceAssetSpy).toHaveBeenCalledWith({
        project_name: "demo",
        file_path: "travel_references/osaka-map.png",
        asset_type: "scene",
        name: "osaka-map",
        description: "旅游路线参考图：travel_references/osaka-map.png",
        conflict_policy: "rename",
      });
      expect(API.applyAssetsToProject).toHaveBeenCalledWith({
        asset_ids: ["scene-osaka-map"],
        target_project: "demo",
        conflict_policy: "skip",
      });
      expect(scenesSpy).toHaveBeenCalledWith("demo");
      expect(charactersSpy).not.toHaveBeenCalled();
      expect(propsSpy).not.toHaveBeenCalled();
      expect(API.generateEpisodeDraft).toHaveBeenCalledWith("demo", 1);
      expect(API.generateEpisodeScript).toHaveBeenCalledWith("demo", 1);
      expect(API.listReferenceVideoUnits).toHaveBeenCalledWith("demo", 1);
      expect(API.generateReferenceVideoUnit).toHaveBeenCalledWith("demo", 1, "E1U1");
      expect(location.history?.at(-1)).toBe("/episodes/1");
    });
  }, 10_000);

  it("renders a generation-ready travel route preview and opens settings", () => {
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            content_type: "travel_video",
            content_mode: "narration",
            generation_mode: "reference_video",
            aspect_ratio: "9:16",
            travel_video_settings: {
              origin: "大阪难波站",
              destination: "黑门市场",
              route_source: "manual",
              route_notes: "沿千日前通前进，看到商店街后右转。",
              route_preview: {
                source: "manual",
                google_configured: false,
                route_ready: true,
                origin: "大阪难波站",
                destination: "黑门市场",
                summary: "大阪难波站 -> 黑门市场",
                distance_text: "1.2 km",
                duration_text: "15 mins",
                nodes: [
                  {
                    id: "node-1",
                    label: "千日前通",
                    instruction: "沿千日前通向东步行。",
                    source: "manual",
                  },
                ],
                reference_images: [],
                warnings: [],
                generated_at: "2026-05-02T00:00:00+08:00",
              },
              narration_language: "zh",
              target_duration: "60s",
              camera_style: "street_walk_turns",
              narrator_persona: "enthusiastic_guide",
              character_notes: "导游轻松但笃定。",
            },
          })}
        />
      </Router>,
    );

    expect(screen.getByText("生成前路线确认")).toBeInTheDocument();
    expect(screen.getByText("可生成")).toBeInTheDocument();
    expect(screen.getByText("大阪难波站")).toBeInTheDocument();
    expect(screen.getByText("黑门市场")).toBeInTheDocument();
    expect(screen.getByText("路线预检结果")).toBeInTheDocument();
    expect(screen.getByText("大阪难波站 -> 黑门市场")).toBeInTheDocument();
    expect(screen.getByText("1.2 km")).toBeInTheDocument();
    expect(screen.getByText("15 mins")).toBeInTheDocument();
    expect(screen.getByText("千日前通")).toBeInTheDocument();
    expect(screen.getAllByText("竖屏 9:16").length).toBeGreaterThan(0);
    expect(screen.getByText("60s 细致讲解")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /完善路线配置|Complete Route Settings/ }));

    expect(location.history?.at(-1)).toBe("/app/projects/demo/settings");
  });

  it("treats uploaded travel route reference images as route-ready", () => {
    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          content_type: "travel_video",
          content_mode: "narration",
          generation_mode: "reference_video",
          travel_video_settings: {
            route_source: "reference_images",
            reference_images: ["travel_references/osaka-map.png"],
          },
        })}
      />,
    );

    expect(screen.getByText("生成前路线确认")).toBeInTheDocument();
    expect(screen.getByText("可生成")).toBeInTheDocument();
    expect(screen.getAllByText("路线参考图").length).toBeGreaterThan(0);
    expect(screen.getByText("1 张")).toBeInTheDocument();
    expect(screen.getByAltText("旅游路线参考图")).toHaveAttribute(
      "src",
      expect.stringContaining("travel_references/osaka-map.png"),
    );
  });

  it("previews the travel route delivery checklist from the overview panel", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: {
        blocking: [],
        auto_fixed: [],
        warnings: [],
      },
      delivery_report: {
        format_version: 1,
        status: "ready",
        generated_at: "2026-05-02T00:00:00+08:00",
        totals: {
          episodes: 1,
          ready_episodes: 1,
          scripts_ready: 1,
          storyboards_ready: 0,
          storyboards_total: 0,
          videos_ready: 1,
          videos_total: 1,
          blocking_issues: 0,
          warnings: 0,
        },
        episodes: [],
        travel_route: {
          route_ready: true,
          source: "reference_images",
          origin: "大阪难波站",
          destination: "黑门市场",
          summary: "大阪难波站 -> 黑门市场",
          nodes_total: 1,
          nodes_covered: 1,
          reference_images_count: 1,
          usable_reference_images_count: 1,
          nodes: [],
        },
      },
      travel_route_assets: {
        format_version: 1,
        generated_at: "2026-05-02T00:00:00+08:00",
        route: {
          route_ready: true,
          source: "reference_images",
          origin: "大阪难波站",
          destination: "黑门市场",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 1,
          covered: 1,
          missing: [],
        },
        reference_images: {
          total: 1,
          usable: 1,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
          ],
        },
        nodes: [
          {
            id: "reference-1",
            label: "参考图 1",
            instruction: "travel_references/osaka-map.png",
            source: "reference_image",
            covered: true,
            matched_units: ["E1U1"],
            matched_unit_details: [
              {
                id: "E1U1",
                episode: 1,
                title: "第一集",
                script_file: "scripts/episode_1.json",
              },
            ],
            reference_images: ["travel_references/osaka-map.png"],
          },
        ],
      },
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            content_type: "travel_video",
            content_mode: "narration",
            generation_mode: "reference_video",
            travel_video_settings: {
              route_source: "reference_images",
              reference_images: ["travel_references/osaka-map.png"],
              route_preview: {
                source: "reference_images",
                google_configured: false,
                route_ready: true,
                summary: "大阪难波站 -> 黑门市场",
                reference_images: ["travel_references/osaka-map.png"],
                nodes: [
                  {
                    id: "reference-1",
                    label: "参考图 1",
                    instruction: "travel_references/osaka-map.png",
                    source: "reference_image",
                  },
                ],
                warnings: [],
              },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /预览交付清单|Preview Checklist/ }));

    expect(await screen.findByText("路线交付清单预览")).toBeInTheDocument();
    expect(screen.getAllByText("大阪难波站 -> 黑门市场").length).toBeGreaterThan(0);
    expect(screen.getByText("E1U1 · 第 1 集 · 第一集")).toBeInTheDocument();
    expect(screen.getAllByText("travel_references/osaka-map.png").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /参考图 1[\s\S]*(打开视频单元|Open Unit)/ }));
    expect(location.history?.at(-1)).toBe("/episodes/1");
    expect(useAppStore.getState().scrollTarget).toEqual(expect.objectContaining({
      type: "reference-unit",
      id: "E1U1",
      route: "/episodes/1",
      highlight: true,
    }));
    expect(API.requestExportPreflight).toHaveBeenCalledWith("demo", "current");
  });

  it("opens the asset library search from a travel route reference image", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      delivery_report: null,
      travel_route_assets: {
        format_version: 1,
        route: {
          route_ready: true,
          source: "reference_images",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 1,
          covered: 1,
          missing: [],
        },
        reference_images: {
          total: 1,
          usable: 1,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
          ],
        },
        nodes: [
          {
            id: "reference-1",
            label: "参考图 1",
            covered: true,
            matched_units: [],
            reference_images: ["travel_references/osaka-map.png"],
          },
        ],
      },
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            content_type: "travel_video",
            content_mode: "narration",
            generation_mode: "reference_video",
            travel_video_settings: {
              route_source: "reference_images",
              reference_images: ["travel_references/osaka-map.png"],
              route_preview: {
                source: "reference_images",
                google_configured: false,
                route_ready: true,
                summary: "大阪难波站 -> 黑门市场",
                reference_images: ["travel_references/osaka-map.png"],
                nodes: [],
                warnings: [],
              },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /预览交付清单|Preview Checklist/ }));
    fireEvent.click(await screen.findByRole("button", { name: /在资产库查找|Find in Library/ }));

    expect(location.history?.at(-1)).toBe("/app/assets?type=scene&q=osaka-map&travelRef=travel_references%2Fosaka-map.png&targetProject=demo");
  });

  it("auto-opens the travel route asset checklist from the preflight action URL", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      delivery_report: null,
      travel_route_assets: {
        format_version: 1,
        route: {
          route_ready: true,
          source: "reference_images",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 1,
          covered: 1,
          missing: [],
        },
        reference_images: {
          total: 1,
          usable: 1,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
          ],
        },
        nodes: [],
      },
    });
    window.history.pushState(null, "", "/app/projects/demo?openTravelRouteAssets=1");
    const location = memoryLocation({ path: "/app/projects/demo?openTravelRouteAssets=1", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            content_type: "travel_video",
            content_mode: "narration",
            generation_mode: "reference_video",
            travel_video_settings: {
              route_source: "reference_images",
              reference_images: ["travel_references/osaka-map.png"],
              route_preview: {
                source: "reference_images",
                google_configured: false,
                route_ready: true,
                summary: "大阪难波站 -> 黑门市场",
                reference_images: ["travel_references/osaka-map.png"],
                nodes: [],
                warnings: [],
              },
            },
          })}
        />
      </Router>,
    );

    expect(await screen.findByText("路线交付清单预览")).toBeInTheDocument();
    expect(API.requestExportPreflight).toHaveBeenCalledWith("demo", "current");
    expect(window.location.search).not.toContain("openTravelRouteAssets");
  });

  it("saves a travel route reference image into the scene asset library", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      delivery_report: null,
      travel_route_assets: {
        format_version: 1,
        route: {
          route_ready: true,
          source: "reference_images",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 1,
          covered: 1,
          missing: [],
        },
        reference_images: {
          total: 1,
          usable: 1,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
          ],
        },
        nodes: [],
      },
    });
    vi.spyOn(API, "addAssetFromProjectFile").mockResolvedValue({
      asset: {
        id: "scene-osaka",
        type: "scene",
        name: "osaka-map",
        description: "旅游路线参考图：travel_references/osaka-map.png",
        voice_style: "",
        image_path: "_global_assets/scene/osaka-map.png",
        source_project: "demo",
        updated_at: "2026-05-02T00:00:00+08:00",
      },
    });
    vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [{ id: "scene-osaka", name: "osaka-map" }],
      skipped: [],
      failed: [],
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: {},
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            content_type: "travel_video",
            content_mode: "narration",
            generation_mode: "reference_video",
            travel_video_settings: {
              route_source: "reference_images",
              reference_images: ["travel_references/osaka-map.png"],
              route_preview: {
                source: "reference_images",
                google_configured: false,
                route_ready: true,
                summary: "大阪难波站 -> 黑门市场",
                reference_images: ["travel_references/osaka-map.png"],
                nodes: [],
                warnings: [],
              },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /预览交付清单|Preview Checklist/ }));
    fireEvent.click(await screen.findByRole("button", { name: /一键入库|Save to Library/ }));

    await waitFor(() => {
      expect(API.addAssetFromProjectFile).toHaveBeenCalledWith({
        project_name: "demo",
        file_path: "travel_references/osaka-map.png",
        asset_type: "scene",
        name: "osaka-map",
        description: "旅游路线参考图：travel_references/osaka-map.png",
        conflict_policy: "rename",
      });
      expect(API.applyAssetsToProject).toHaveBeenCalledWith({
        asset_ids: ["scene-osaka"],
        target_project: "demo",
        conflict_policy: "skip",
      });
      expect(location.history?.at(-1)).toBe(
        "/app/assets?type=scene&q=osaka-map&travelRef=travel_references%2Fosaka-map.png&targetProject=demo&focus=scene-osaka",
      );
    });
    expect(useAppStore.getState().toast?.text).toContain("已入库为场景素材");
  });

  it("saves all usable travel route reference images into the scene asset library", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      delivery_report: null,
      travel_route_assets: {
        format_version: 1,
        route: {
          route_ready: true,
          source: "reference_images",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 2,
          covered: 2,
          missing: [],
        },
        reference_images: {
          total: 3,
          usable: 2,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
            {
              id: "reference-2",
              path: "travel_references/guide.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/guide.png",
              used_by_nodes: ["reference-2"],
            },
            {
              id: "reference-3",
              path: "https://example.com/remote.jpg",
              kind: "remote",
              usable: true,
              html_src: "https://example.com/remote.jpg",
              used_by_nodes: ["reference-3"],
            },
          ],
        },
        nodes: [],
      },
    });
    const addAssetSpy = vi.spyOn(API, "addAssetFromProjectFile").mockImplementation(async (payload) => ({
      asset: {
        id: `scene-${payload.name}`,
        type: "scene",
        name: payload.name ?? "scene",
        description: payload.description ?? "",
        voice_style: "",
        image_path: `_global_assets/scene/${payload.name}.png`,
        source_project: "demo",
        updated_at: "2026-05-02T00:00:00+08:00",
      },
    }));
    vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [
        { id: "scene-osaka-map", name: "osaka-map" },
        { id: "scene-guide", name: "guide" },
      ],
      skipped: [],
      failed: [],
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: {},
    });

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          content_type: "travel_video",
          content_mode: "narration",
          generation_mode: "reference_video",
          travel_video_settings: {
            route_source: "reference_images",
            reference_images: ["travel_references/osaka-map.png", "travel_references/guide.png"],
            route_preview: {
              source: "reference_images",
              google_configured: false,
              route_ready: true,
              summary: "大阪难波站 -> 黑门市场",
              reference_images: ["travel_references/osaka-map.png", "travel_references/guide.png"],
              nodes: [],
              warnings: [],
            },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /预览交付清单|Preview Checklist/ }));
    fireEvent.click(await screen.findByRole("button", { name: /全部入库 2 张|Save All 2/ }));

    await waitFor(() => {
      expect(addAssetSpy).toHaveBeenCalledTimes(2);
      expect(addAssetSpy).toHaveBeenNthCalledWith(1, {
        project_name: "demo",
        file_path: "travel_references/osaka-map.png",
        asset_type: "scene",
        name: "osaka-map",
        description: "旅游路线参考图：travel_references/osaka-map.png",
        conflict_policy: "rename",
      });
      expect(addAssetSpy).toHaveBeenNthCalledWith(2, {
        project_name: "demo",
        file_path: "travel_references/guide.png",
        asset_type: "scene",
        name: "guide",
        description: "旅游路线参考图：travel_references/guide.png",
        conflict_policy: "rename",
      });
      expect(API.applyAssetsToProject).toHaveBeenCalledWith({
        asset_ids: ["scene-osaka-map", "scene-guide"],
        target_project: "demo",
        conflict_policy: "skip",
      });
    });
    expect(await screen.findByText("已入库并应用 2 张旅游参考图，可继续检查路线交付清单。")).toBeInTheDocument();
    expect(useAppStore.getState().toast?.text).toContain("已入库并应用 2 张旅游参考图");
  });

  it("keeps failed travel route references actionable after a partial batch save", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      delivery_report: null,
      travel_route_assets: {
        format_version: 1,
        route: {
          route_ready: true,
          source: "reference_images",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 2,
          covered: 2,
          missing: [],
        },
        reference_images: {
          total: 2,
          usable: 2,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
            {
              id: "reference-2",
              path: "travel_references/guide.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/guide.png",
              used_by_nodes: ["reference-2"],
            },
          ],
        },
        nodes: [],
      },
    });
    vi.spyOn(API, "addAssetFromProjectFile").mockImplementation(async (payload) => {
      if (payload.file_path === "travel_references/guide.png") {
        throw new Error("upload failed");
      }
      return {
        asset: {
          id: "scene-osaka-map",
          type: "scene",
          name: payload.name ?? "osaka-map",
          description: payload.description ?? "",
          voice_style: "",
          image_path: "_global_assets/scene/osaka-map.png",
          source_project: "demo",
          updated_at: "2026-05-02T00:00:00+08:00",
        },
      };
    });
    vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [{ id: "scene-osaka-map", name: "osaka-map" }],
      skipped: [],
      failed: [],
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: {},
    });

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          content_type: "travel_video",
          content_mode: "narration",
          generation_mode: "reference_video",
          travel_video_settings: {
            route_source: "reference_images",
            reference_images: ["travel_references/osaka-map.png", "travel_references/guide.png"],
            route_preview: {
              source: "reference_images",
              google_configured: false,
              route_ready: true,
              summary: "大阪难波站 -> 黑门市场",
              reference_images: ["travel_references/osaka-map.png", "travel_references/guide.png"],
              nodes: [],
              warnings: [],
            },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /预览交付清单|Preview Checklist/ }));
    fireEvent.click(await screen.findByRole("button", { name: /全部入库 2 张|Save All 2/ }));

    expect(await screen.findByText("已入库并应用 1 张旅游参考图，1 张未完成，请检查后继续。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /全部入库 1 张|Save All 1/ })).toBeInTheDocument();
  });

  it("marks already applied travel reference images and skips them during batch save", async () => {
    vi.spyOn(API, "requestExportPreflight").mockResolvedValue({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      delivery_report: null,
      travel_route_assets: {
        format_version: 1,
        route: {
          route_ready: true,
          source: "reference_images",
          summary: "大阪难波站 -> 黑门市场",
        },
        node_coverage: {
          total: 2,
          covered: 2,
          missing: [],
        },
        reference_images: {
          total: 2,
          usable: 2,
          items: [
            {
              id: "reference-1",
              path: "travel_references/osaka-map.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/osaka-map.png",
              used_by_nodes: ["reference-1"],
            },
            {
              id: "reference-2",
              path: "travel_references/guide.png",
              kind: "local",
              usable: true,
              html_src: "../travel_references/guide.png",
              used_by_nodes: ["reference-2"],
            },
          ],
        },
        nodes: [],
      },
    });
    const addAssetSpy = vi.spyOn(API, "addAssetFromProjectFile").mockResolvedValue({
      asset: {
        id: "scene-guide",
        type: "scene",
        name: "guide",
        description: "旅游路线参考图：travel_references/guide.png",
        voice_style: "",
        image_path: "_global_assets/scene/guide.png",
        source_project: "demo",
        updated_at: "2026-05-02T00:00:00+08:00",
      },
    });
    vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [{ id: "scene-guide", name: "guide" }],
      skipped: [],
      failed: [],
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: {},
    });

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          content_type: "travel_video",
          content_mode: "narration",
          generation_mode: "reference_video",
          scenes: {
            黑门市场: {
              description: "旅游路线参考图",
              scene_sheet: "_global_assets/scene/osaka-map.png",
              asset_source: {
                kind: "asset_library",
                asset_id: "scene-osaka",
                asset_type: "scene",
                source_kind: "travel_reference",
                source_project: "demo",
                source_file: "travel_references/osaka-map.png",
              },
            },
          },
          travel_video_settings: {
            route_source: "reference_images",
            reference_images: ["travel_references/osaka-map.png", "travel_references/guide.png"],
            route_preview: {
              source: "reference_images",
              google_configured: false,
              route_ready: true,
              summary: "大阪难波站 -> 黑门市场",
              reference_images: ["travel_references/osaka-map.png", "travel_references/guide.png"],
              nodes: [],
              warnings: [],
            },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /预览交付清单|Preview Checklist/ }));

    expect(await screen.findByText("已应用到场景：黑门市场")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /全部入库 1 张|Save All 1/ }));

    await waitFor(() => {
      expect(addAssetSpy).toHaveBeenCalledTimes(1);
      expect(addAssetSpy).toHaveBeenCalledWith({
        project_name: "demo",
        file_path: "travel_references/guide.png",
        asset_type: "scene",
        name: "guide",
        description: "旅游路线参考图：travel_references/guide.png",
        conflict_policy: "rename",
      });
      expect(API.applyAssetsToProject).toHaveBeenCalledWith({
        asset_ids: ["scene-guide"],
        target_project: "demo",
        conflict_policy: "skip",
      });
    });
  });

  it("blocks travel-video quickstart until route settings are present", async () => {
    const scenesSpy = vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: {},
      source: "overview",
      added: 0,
      updated: 0,
      skipped: 0,
    });
    const routePreviewSpy = vi.spyOn(API, "previewTravelRoute").mockResolvedValue({
      source: "google",
      google_configured: true,
      route_ready: true,
      origin: null,
      destination: null,
      summary: null,
      distance_text: null,
      duration_text: null,
      nodes: [],
      reference_images: [],
      warnings: [],
      generated_at: "2026-05-02T00:00:00+08:00",
    });
    window.history.pushState(null, "", "/app/projects/demo?workflow=quickstart");

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          content_type: "travel_video",
          content_mode: "narration",
          generation_mode: "reference_video",
          travel_video_settings: {
            route_source: "google_street_view",
          },
          episodes: [],
          status: {
            current_phase: "scripting",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /一键起步|One-click kickoff/ })[0]);

    expect(await screen.findByText("旅游视频需要先填写出发地+目的地、手动路线说明，或上传至少一张路线参考图。")).toBeInTheDocument();
    expect(routePreviewSpy).not.toHaveBeenCalled();
    expect(scenesSpy).not.toHaveBeenCalled();
  }, 10_000);

  it("blocks travel-video quickstart when the route precheck is not ready", async () => {
    const scenesSpy = vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: {},
      source: "overview",
      added: 0,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "previewTravelRoute").mockResolvedValue({
      source: "manual",
      google_configured: false,
      route_ready: false,
      origin: "大阪难波站",
      destination: "黑门市场",
      summary: null,
      distance_text: null,
      duration_text: null,
      nodes: [],
      reference_images: [],
      warnings: [{ code: "route_incomplete", message: "路线节点不足，请补充路线说明。" }],
      generated_at: "2026-05-02T00:00:00+08:00",
    });
    window.history.pushState(null, "", "/app/projects/demo?workflow=quickstart");

    render(
      <OverviewCanvas
        projectName="demo"
        projectData={makeProjectData({
          content_type: "travel_video",
          content_mode: "narration",
          generation_mode: "reference_video",
          travel_video_settings: {
            origin: "大阪难波站",
            destination: "黑门市场",
            route_source: "manual",
          },
          episodes: [],
          status: {
            current_phase: "scripting",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /一键起步|One-click kickoff/ })[0]);

    expect(await screen.findByText("路线节点不足，请补充路线说明。")).toBeInTheDocument();
    expect(scenesSpy).not.toHaveBeenCalled();
  }, 10_000);

  it("shows failed quickstart steps and retries from the failed step", async () => {
    const refreshedProject = makeProjectData({
      episodes: [],
      characters: { Hero: { description: "hero" } },
      scenes: { Office: { description: "office" } },
      props: { Contract: { description: "contract" } },
      status: {
        current_phase: "scripting",
        phase_progress: 0,
        characters: { total: 1, completed: 0 },
        scenes: { total: 1, completed: 0 },
        props: { total: 1, completed: 0 },
        episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
      },
    });
    vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: refreshedProject.characters,
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: refreshedProject.scenes ?? {},
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: refreshedProject.props ?? {},
      source: "overview",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateEpisodeDraft")
      .mockRejectedValueOnce(new Error("draft boom"))
      .mockResolvedValueOnce({
        success: true,
        episode: 1,
        title: "第 1 集",
        script_file: "scripts/episode_1.json",
        draft_path: "drafts/episode_1/step1_segments.md",
        content: "# draft",
        source: "overview",
      });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: refreshedProject,
      scripts: {},
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({
            episodes: [],
            status: {
              current_phase: "scripting",
              phase_progress: 0,
              characters: { total: 0, completed: 0 },
              scenes: { total: 0, completed: 0 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
            },
          })}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /一键起步|One-click kickoff/ }));

    expect(await screen.findByText("draft boom")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: /重试这一步|Retry This Step/ });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(API.generateEpisodeDraft).toHaveBeenCalledTimes(2);
      expect(API.generateEpisodeDraft).toHaveBeenLastCalledWith("demo", 1);
      expect(location.history?.at(-1)).toBe("/episodes/1");
    });
  }, 10_000);

  it("skips active asset design tasks during one-click preparation", async () => {
    const preparedProject = makeProjectData({
      characters: {
        Hero: { description: "hero" },
        Mentor: { description: "mentor" },
      },
      scenes: {
        Office: { description: "office" },
        Apartment: { description: "apartment" },
      },
      props: {
        Contract: { description: "contract" },
        Phone: { description: "phone" },
      },
    });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "character",
          media_type: "image",
          resource_id: "Hero",
          status: "queued",
        }),
        makeTask({
          task_id: "scene-active",
          project_name: "demo",
          task_type: "scene",
          media_type: "image",
          resource_id: "Office",
          status: "running",
        }),
        makeTask({
          task_id: "prop-active",
          project_name: "demo",
          task_type: "prop",
          media_type: "image",
          resource_id: "Contract",
          status: "queued",
        }),
      ],
    });
    vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: preparedProject.characters,
      source: "source",
      added: 2,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: preparedProject.scenes ?? {},
      source: "source",
      added: 2,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: preparedProject.props ?? {},
      source: "source",
      added: 2,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: preparedProject,
      scripts: {},
    });
    const generateCharacter = vi.spyOn(API, "generateCharacter").mockResolvedValue({ success: true, task_id: "c-1", message: "ok" });
    const generateScene = vi.spyOn(API, "generateProjectScene").mockResolvedValue({ success: true, task_id: "s-1", message: "ok" });
    const generateProp = vi.spyOn(API, "generateProjectProp").mockResolvedValue({ success: true, task_id: "p-1", message: "ok" });

    render(<OverviewCanvas projectName="demo" projectData={makeProjectData()} />);

    const assetButtons = screen.getAllByRole("button", { name: /一键准备资产|Prepare Assets/ });
    const assetButton = assetButtons.find((button) => !button.textContent?.match(/下一步|Next/));
    expect(assetButton).toBeDefined();
    fireEvent.click(assetButton!);

    await waitFor(() => {
      expect(generateCharacter).toHaveBeenCalledTimes(1);
      expect(generateCharacter).toHaveBeenCalledWith("demo", "Mentor", "mentor");
      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(generateScene).toHaveBeenCalledWith("demo", "Apartment", "apartment");
      expect(generateProp).toHaveBeenCalledTimes(1);
      expect(generateProp).toHaveBeenCalledWith("demo", "Phone", "phone");
    });
  }, 10_000);

  it("can complete asset lists without submitting design tasks", async () => {
    const preparedProject = makeProjectData({
      characters: { Hero: { description: "hero" } },
      scenes: { Office: { description: "office" } },
      props: { Contract: { description: "contract" } },
    });
    vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: preparedProject.characters,
      source: "source",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: preparedProject.scenes ?? {},
      source: "source",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: preparedProject.props ?? {},
      source: "source",
      added: 1,
      updated: 0,
      skipped: 0,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: preparedProject,
      scripts: {},
    });
    const generateCharacter = vi.spyOn(API, "generateCharacter").mockResolvedValue({ success: true, task_id: "c-1", message: "ok" });
    const generateScene = vi.spyOn(API, "generateProjectScene").mockResolvedValue({ success: true, task_id: "s-1", message: "ok" });
    const generateProp = vi.spyOn(API, "generateProjectProp").mockResolvedValue({ success: true, task_id: "p-1", message: "ok" });

    render(<OverviewCanvas projectName="demo" projectData={makeProjectData()} />);

    fireEvent.click(screen.getByRole("button", { name: /只补清单|Lists Only/ }));

    await waitFor(() => {
      expect(API.generateProjectCharacters).toHaveBeenCalledWith("demo");
      expect(API.generateProjectScenes).toHaveBeenCalledWith("demo");
      expect(API.generateProjectProps).toHaveBeenCalledWith("demo");
      expect(generateCharacter).not.toHaveBeenCalled();
      expect(generateScene).not.toHaveBeenCalled();
      expect(generateProp).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("资产清单已补全");
    });
  }, 10_000);

  it("generates the first episode draft and opens episode view", async () => {
    const projectWithEpisode = makeProjectData({
      episodes: [{ episode: 1, title: "第 1 集", script_file: "scripts/episode_1.json" }],
    });
    vi.spyOn(API, "generateEpisodeDraft").mockResolvedValue({
      success: true,
      episode: 1,
      title: "第 1 集",
      script_file: "scripts/episode_1.json",
      draft_path: "drafts/episode_1/step1_segments.md",
      content: "# draft",
      source: "source",
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: projectWithEpisode,
      scripts: {},
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas
          projectName="demo"
          projectData={makeProjectData({ episodes: [] })}
        />
      </Router>,
    );

    const draftButtons = screen.getAllByRole("button", { name: /生成第 1 集草稿|Generate Episode 1 Draft/ });
    const draftButton = draftButtons.find(
      (button) =>
        !button.textContent?.match(/下一步|Next/) &&
        button.className.includes("border-indigo-400"),
    );
    expect(draftButton).toBeDefined();
    fireEvent.click(draftButton!);

    await waitFor(() => {
      expect(API.generateEpisodeDraft).toHaveBeenCalledWith("demo", 1);
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(location.history?.at(-1)).toBe("/episodes/1");
      expect(useAppStore.getState().toast?.text).toContain("第 1 集草稿已生成");
    });
  }, 10_000);

  it("generates the next episode draft from the episode list header", async () => {
    const projectWithSecondEpisode = makeProjectData({
      episodes: [
        { episode: 1, title: "EP1", script_file: "scripts/episode_1.json" },
        { episode: 2, title: "第 2 集", script_file: "scripts/episode_2.json" },
      ],
    });
    vi.spyOn(API, "generateEpisodeDraft").mockResolvedValue({
      success: true,
      episode: 2,
      title: "第 2 集",
      script_file: "scripts/episode_2.json",
      draft_path: "drafts/episode_2/step1_segments.md",
      content: "# draft",
      source: "source",
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: projectWithSecondEpisode,
      scripts: {},
    });
    const location = memoryLocation({ path: "/", record: true });

    render(
      <Router hook={location.hook}>
        <OverviewCanvas projectName="demo" projectData={makeProjectData()} />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /生成第 2 集草稿|Generate Episode 2 Draft/ }));

    await waitFor(() => {
      expect(API.generateEpisodeDraft).toHaveBeenCalledWith("demo", 2);
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(location.history?.at(-1)).toBe("/episodes/2");
      expect(useAppStore.getState().toast?.text).toContain("第 2 集草稿已生成");
    });
  }, 10_000);
});
