import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useTasksStore } from "@/stores/tasks-store";
import { TimelineCanvas } from "./TimelineCanvas";
import { makeTask } from "@/test/factories";
import type { EpisodeScript, ProjectData } from "@/types";
import type { GridGeneration } from "@/types/grid";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 200,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 200,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("./SegmentCard", () => ({
  SegmentCard: ({
    segment,
    generatingStoryboard,
    generatingVideo,
  }: {
    segment: { segment_id?: string; scene_id?: string };
    generatingStoryboard?: boolean;
    generatingVideo?: boolean;
  }) => {
    const id = segment.segment_id ?? segment.scene_id ?? "";
    return (
      <div data-testid="segment-card">
        <span>{id}</span>
        <button data-testid={`${id}-storyboard`} disabled={generatingStoryboard}>
          {generatingStoryboard ? "storyboard generating" : "storyboard idle"}
        </button>
        <button data-testid={`${id}-video`} disabled={generatingVideo}>
          {generatingVideo ? "video generating" : "video idle"}
        </button>
      </div>
    );
  },
}));

vi.mock("./GridPreviewPanel", () => ({
  GridPreviewPanel: () => <div data-testid="grid-preview" />,
}));

function makeProjectData(): ProjectData {
  return {
    title: "Demo",
    content_mode: "narration",
    style: "",
    generation_mode: "grid",
    episodes: [
      {
        episode: 1,
        title: "EP1",
        script_file: "episode_1.json",
        generation_mode: "grid",
      },
    ],
    characters: {},
    scenes: {},
    props: {},
  };
}

function makeScript(): EpisodeScript {
  return {
    episode: 1,
    title: "EP1",
    content_mode: "narration",
    duration_seconds: 8,
    summary: "summary",
    novel: { title: "n", chapter: "1" },
    segments: [
      {
        segment_id: "SEG-1",
        episode: 1,
        duration_seconds: 4,
        segment_break: false,
        novel_text: "text 1",
        characters_in_segment: [],
        scenes: [],
        props: [],
        image_prompt: "image prompt 1",
        video_prompt: "video prompt 1",
        transition_to_next: "cut",
      },
      {
        segment_id: "SEG-2",
        episode: 1,
        duration_seconds: 4,
        segment_break: false,
        novel_text: "text 2",
        characters_in_segment: [],
        scenes: [],
        props: [],
        image_prompt: "image prompt 2",
        video_prompt: "video prompt 2",
        transition_to_next: "cut",
      },
    ],
  };
}

function makeGrid(overrides: Partial<GridGeneration> = {}): GridGeneration {
  return {
    id: "grid_1",
    episode: 1,
    script_file: "episode_1.json",
    scene_ids: ["SEG-1", "SEG-2"],
    grid_image_path: null,
    rows: 2,
    cols: 2,
    cell_count: 4,
    frame_chain: [],
    status: "pending",
    prompt: null,
    provider: "",
    model: "",
    grid_size: "grid_4",
    created_at: "2026-05-01T00:00:00Z",
    error_message: null,
    ...overrides,
  };
}

async function confirmGenerationPreflight() {
  expect(await screen.findByText("生成前检查")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
}

describe("TimelineCanvas", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useTasksStore.setState(useTasksStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.spyOn(API, "requestGenerationPreflight").mockResolvedValue({
      project_name: "demo",
      task_type: "storyboard",
      resource_id: "episode-1",
      billing_mode: "platform_credits",
      required_credits: 2,
      count: 1,
      balance: 100,
      available_balance: 100,
      reserved_generation_credits: 0,
      minimum_generation_balance: 1,
      can_submit: true,
      blocking: [],
      warnings: [],
    });
  });

  it("shows active segment task states and counts only submittable batch work", () => {
    const base = makeScript();
    if (base.content_mode !== "narration") throw new Error("expected narration script");
    const segment = base.segments[0];
    const readyAssets = {
      storyboard_image: "storyboards/ready.png",
      storyboard_last_image: null,
      grid_id: null,
      grid_cell_index: null,
      video_clip: null,
      video_thumbnail: null,
      video_uri: null,
      status: "storyboard_ready" as const,
    };
    const script: Extract<EpisodeScript, { content_mode: "narration" }> = {
      ...base,
      segments: [
        { ...segment, segment_id: "SEG-1", generated_assets: undefined },
        { ...segment, segment_id: "SEG-2", generated_assets: undefined },
        { ...segment, segment_id: "SEG-3", generated_assets: readyAssets },
        { ...segment, segment_id: "SEG-4", generated_assets: readyAssets },
      ],
    };
    const projectData: ProjectData = {
      ...makeProjectData(),
      generation_mode: "storyboard",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          generation_mode: "storyboard",
        },
      ],
    };
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
        makeTask({
          task_id: "video-active",
          project_name: "demo",
          task_type: "video",
          media_type: "video",
          resource_id: "SEG-3",
          script_file: "scripts/episode_1.json",
          status: "running",
        }),
      ],
    });

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={script}
        scriptFile="scripts/episode_1.json"
        projectData={projectData}
        onGenerateEpisodeStoryboards={vi.fn()}
        onGenerateEpisodeVideos={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /生成缺失分镜 1|Generate Missing Storyboards 1/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /生成可生成视频 1|Generate Ready Videos 1/ })).not.toBeDisabled();
    expect(screen.getByTestId("SEG-1-storyboard")).toBeDisabled();
    expect(screen.getByTestId("SEG-2-storyboard")).not.toBeDisabled();
    expect(screen.getByTestId("SEG-3-video")).toBeDisabled();
    expect(screen.getByTestId("SEG-4-video")).not.toBeDisabled();
  });

  it("surfaces the next workflow action when a draft exists but no script is generated", () => {
    vi.spyOn(API, "getDraftContent").mockResolvedValue("# draft");
    const onGenerateEpisodeScript = vi.fn();

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeTitle="EP1"
        hasDraft
        episodeScript={null}
        projectData={makeProjectData()}
        onGenerateEpisodeScript={onGenerateEpisodeScript}
      />,
    );

    expect(screen.getByText("草稿已准备好，下一步生成正式剧本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /生成剧本|Generate Script/ }));

    expect(onGenerateEpisodeScript).toHaveBeenCalledWith(1);
  });

  it("surfaces storyboard generation as the next action after script generation", async () => {
    const onGenerateEpisodeStoryboards = vi.fn();
    const projectData: ProjectData = {
      ...makeProjectData(),
      generation_mode: "storyboard",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          generation_mode: "storyboard",
        },
      ],
    };

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={makeScript()}
        scriptFile="scripts/episode_1.json"
        projectData={projectData}
        onGenerateEpisodeStoryboards={onGenerateEpisodeStoryboards}
      />,
    );

    expect(screen.getByText("剧本已生成，下一步生成分镜")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开始生成分镜|Start Storyboards/ }));
    await confirmGenerationPreflight();

    expect(onGenerateEpisodeStoryboards).toHaveBeenCalledWith(1, "scripts/episode_1.json");
  });

  it("surfaces video generation as the next action after storyboards are ready", async () => {
    const base = makeScript();
    if (base.content_mode !== "narration") throw new Error("expected narration script");
    const storyboardReady = {
      storyboard_image: "storyboards/ready.png",
      storyboard_last_image: null,
      grid_id: null,
      grid_cell_index: null,
      video_clip: null,
      video_thumbnail: null,
      video_uri: null,
      status: "storyboard_ready" as const,
    };
    const script: Extract<EpisodeScript, { content_mode: "narration" }> = {
      ...base,
      segments: base.segments.map((segment) => ({
        ...segment,
        generated_assets: storyboardReady,
      })),
    };
    const projectData: ProjectData = {
      ...makeProjectData(),
      generation_mode: "storyboard",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          generation_mode: "storyboard",
        },
      ],
    };
    const onGenerateEpisodeVideos = vi.fn();

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={script}
        scriptFile="scripts/episode_1.json"
        projectData={projectData}
        onGenerateEpisodeVideos={onGenerateEpisodeVideos}
      />,
    );

    expect(screen.getByText("分镜已准备好，下一步生成视频")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开始生成视频|Start Videos/ }));
    await confirmGenerationPreflight();

    expect(onGenerateEpisodeVideos).toHaveBeenCalledWith(1, "scripts/episode_1.json");
  });

  it("shows episode production task progress and retries failed tasks", async () => {
    const projectData: ProjectData = {
      ...makeProjectData(),
      generation_mode: "storyboard",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          generation_mode: "storyboard",
        },
      ],
    };
    useTasksStore.setState({
      tasks: [
        makeTask({
          task_id: "storyboard-queued",
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-1",
          script_file: "episode_1.json",
          status: "queued",
        }),
        makeTask({
          task_id: "video-running",
          project_name: "demo",
          task_type: "video",
          media_type: "video",
          resource_id: "SEG-2",
          script_file: "scripts/episode_1.json",
          status: "running",
        }),
        makeTask({
          task_id: "storyboard-done",
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-3",
          script_file: "scripts/episode_1.json",
          status: "succeeded",
        }),
        makeTask({
          task_id: "video-failed",
          project_name: "demo",
          task_type: "video",
          media_type: "video",
          resource_id: "SEG-4",
          script_file: "scripts/episode_1.json",
          status: "failed",
          error_message: "provider timeout",
        }),
        makeTask({
          task_id: "other-episode",
          project_name: "demo",
          task_type: "video",
          media_type: "video",
          resource_id: "SEG-X",
          script_file: "scripts/episode_2.json",
          status: "failed",
          error_message: "other episode",
        }),
      ],
    });
    const retrySpy = vi.spyOn(API, "retryTask").mockResolvedValue({
      task_id: "video-retry",
      status: "queued",
      deduped: false,
      existing_task_id: null,
    });

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={makeScript()}
        scriptFile="scripts/episode_1.json"
        projectData={projectData}
      />,
    );

    expect(screen.getByText("本集制作任务进度")).toBeInTheDocument();
    expect(screen.getByText("provider timeout")).toBeInTheDocument();
    expect(screen.queryByText("other episode")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /重试此任务|Retry this task/ }));
    await confirmGenerationPreflight();

    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith("video-failed"));
    expect(useAppStore.getState().toast?.text).toMatch(/重新加入|generation queue/);
  });

  it("shows episode artifacts and regenerates individual outputs", async () => {
    const base = makeScript();
    if (base.content_mode !== "narration") throw new Error("expected narration script");
    const script: Extract<EpisodeScript, { content_mode: "narration" }> = {
      ...base,
      segments: [
        {
          ...base.segments[0],
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
          ...base.segments[1],
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
    };
    const projectData: ProjectData = {
      ...makeProjectData(),
      generation_mode: "storyboard",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          generation_mode: "storyboard",
        },
      ],
    };
    const onGenerateStoryboard = vi.fn();
    const onGenerateVideo = vi.fn();

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={script}
        scriptFile="scripts/episode_1.json"
        projectData={projectData}
        onGenerateStoryboard={onGenerateStoryboard}
        onGenerateVideo={onGenerateVideo}
      />,
    );

    expect(screen.getByText("本集产物")).toBeInTheDocument();
    expect(screen.getAllByText("正式剧本").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 \/ 2/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 \/ 2/).length).toBeGreaterThan(0);

    const storyboardCard = screen.getByTestId("episode-artifact-storyboard-SEG-1");
    expect(within(storyboardCard).getByRole("link", { name: /查看|Open/ })).toHaveAttribute(
      "href",
      expect.stringContaining("storyboards/scene_SEG-1.png"),
    );
    fireEvent.click(within(storyboardCard).getByRole("button", { name: /重新生成|Regenerate/ }));
    await confirmGenerationPreflight();
    expect(onGenerateStoryboard).toHaveBeenCalledWith("SEG-1", "scripts/episode_1.json");

    const videoCard = screen.getByTestId("episode-artifact-video-SEG-1");
    fireEvent.click(within(videoCard).getByRole("button", { name: /重新生成|Regenerate/ }));
    await confirmGenerationPreflight();
    expect(onGenerateVideo).toHaveBeenCalledWith("SEG-1", "scripts/episode_1.json");
  });

  it("shows delivery checks and auto-fixes the next missing output", async () => {
    const base = makeScript();
    if (base.content_mode !== "narration") throw new Error("expected narration script");
    const script: Extract<EpisodeScript, { content_mode: "narration" }> = {
      ...base,
      segments: base.segments.map((segment, index) => ({
        ...segment,
        generated_assets: {
          storyboard_image: `storyboards/scene_${segment.segment_id}.png`,
          storyboard_last_image: null,
          grid_id: null,
          grid_cell_index: null,
          video_clip: index === 0 ? `videos/scene_${segment.segment_id}.mp4` : null,
          video_thumbnail: index === 0 ? `thumbnails/scene_${segment.segment_id}.jpg` : null,
          video_uri: null,
          status: index === 0 ? "completed" : "storyboard_ready",
        },
      })),
    };
    const projectData: ProjectData = {
      ...makeProjectData(),
      generation_mode: "storyboard",
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          generation_mode: "storyboard",
        },
      ],
    };
    const onGenerateEpisodeVideos = vi.fn();

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={script}
        scriptFile="scripts/episode_1.json"
        projectData={projectData}
        onGenerateEpisodeVideos={onGenerateEpisodeVideos}
      />,
    );

    expect(screen.getByText("分集交付检查")).toBeInTheDocument();
    expect(screen.getByText(/还有 1 项会影响交付/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /一键补齐|Auto Fix/ }));
    await confirmGenerationPreflight();

    expect(onGenerateEpisodeVideos).toHaveBeenCalledWith(1, "scripts/episode_1.json");
  });

  it("does not resubmit grid generation while a matching grid is in progress", async () => {
    vi.spyOn(API, "listGrids").mockResolvedValue([makeGrid({ status: "pending" })]);
    const onGenerateGrid = vi.fn();

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={makeScript()}
        scriptFile="episode_1.json"
        projectData={makeProjectData()}
        onGenerateGrid={onGenerateGrid}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /生成中|Generating/ })).toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /一键生成全部宫格|Generate All Grids/ }));

    expect(onGenerateGrid).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast?.text).toContain("宫格任务已在队列中");
  });

  it("uses active grid queue tasks before grid records refresh", async () => {
    vi.spyOn(API, "listGrids").mockResolvedValue([]);
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "grid",
          media_type: "image",
          resource_id: "grid_active",
          script_file: "episode_1.json",
          status: "running",
        }),
      ],
    });
    const onGenerateGrid = vi.fn();

    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeScript={makeScript()}
        scriptFile="episode_1.json"
        projectData={makeProjectData()}
        onGenerateGrid={onGenerateGrid}
      />,
    );

    expect(screen.getByRole("button", { name: /生成中|Generating/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /一键生成全部宫格|Generate All Grids/ }));

    expect(onGenerateGrid).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast?.text).toContain("宫格任务已在队列中");
  });
});
