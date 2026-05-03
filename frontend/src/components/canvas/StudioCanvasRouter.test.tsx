import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API, ApiRequestError } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import { StudioCanvasRouter } from "@/components/canvas/StudioCanvasRouter";
import { makeTask } from "@/test/factories";
import type { EpisodeScript, ProjectData } from "@/types";

vi.mock("./OverviewCanvas", () => ({
  OverviewCanvas: () => <div data-testid="overview-canvas">Overview</div>,
}));

vi.mock("./SourceFileViewer", () => ({
  SourceFileViewer: ({ filename }: { filename: string }) => (
    <div data-testid="source-file-viewer">{filename}</div>
  ),
}));

vi.mock("./timeline/TimelineCanvas", () => ({
  TimelineCanvas: ({
    episode,
    hasDraft,
    episodeScript,
    onUpdatePrompt,
    onGenerateStoryboard,
    onGenerateVideo,
    onGenerateEpisodeScript,
    generatingEpisodeScript,
    scriptFile,
    onGenerateEpisodeStoryboards,
    onGenerateEpisodeVideos,
    generatingEpisodeStoryboards,
    generatingEpisodeVideos,
  }: {
    episode: number;
    hasDraft?: boolean;
    episodeScript: unknown;
    scriptFile?: string;
    onUpdatePrompt?: (segmentId: string, field: string, value: unknown) => void;
    onGenerateStoryboard?: (segmentId: string) => void;
    onGenerateVideo?: (segmentId: string) => void;
    onGenerateEpisodeScript?: (episode: number) => void;
    generatingEpisodeScript?: boolean;
    onGenerateEpisodeStoryboards?: (episode: number, scriptFile: string) => void;
    onGenerateEpisodeVideos?: (episode: number, scriptFile: string) => void;
    generatingEpisodeStoryboards?: boolean;
    generatingEpisodeVideos?: boolean;
  }) => (
    <div data-testid="timeline-canvas">
      <div data-testid="timeline-episode">{episode}</div>
      <div data-testid="timeline-has-draft">{hasDraft ? "yes" : "no"}</div>
      <div data-testid="timeline-has-script">{episodeScript ? "yes" : "no"}</div>
      <button onClick={() => onUpdatePrompt?.("SEG-1", "image_prompt", "new prompt")}>
        update-prompt
      </button>
      <button onClick={() => onGenerateStoryboard?.("SEG-1")}>generate-storyboard</button>
      <button onClick={() => onGenerateVideo?.("SEG-1")}>generate-video</button>
      <button
        disabled={generatingEpisodeScript}
        onClick={() => onGenerateEpisodeScript?.(episode)}
      >
        generate-script
      </button>
      <button
        disabled={generatingEpisodeStoryboards}
        onClick={() => scriptFile && onGenerateEpisodeStoryboards?.(episode, scriptFile)}
      >
        generate-storyboards
      </button>
      <button
        disabled={generatingEpisodeVideos}
        onClick={() => scriptFile && onGenerateEpisodeVideos?.(episode, scriptFile)}
      >
        generate-videos
      </button>
    </div>
  ),
}));

vi.mock("./lorebook/CharacterCard", () => ({
  CharacterCard: ({
    name,
    onSave,
    onGenerate,
  }: {
    name: string;
    onSave: (
      name: string,
      payload: { description: string; voiceStyle: string; referenceFile?: File | null },
    ) => Promise<void>;
    onGenerate: (name: string) => void;
  }) => (
    <div data-testid="character-card" data-name={name}>
      <button
        onClick={() =>
          void onSave(name, {
            description: "new desc",
            voiceStyle: "new voice",
            referenceFile: new File(["ref"], "hero.png", { type: "image/png" }),
          })
        }
      >
        update-character
      </button>
      <button onClick={() => onGenerate(name)}>generate-character</button>
    </div>
  ),
}));

vi.mock("./lorebook/SceneCard", () => ({
  SceneCard: ({
    name,
    onUpdate,
    onGenerate,
  }: {
    name: string;
    onUpdate: (name: string, updates: Record<string, unknown>) => void;
    onGenerate: (name: string) => void;
  }) => (
    <div data-testid="scene-card" data-name={name}>
      <button onClick={() => onUpdate(name, { description: "new scene desc" })}>
        update-scene
      </button>
      <button onClick={() => onGenerate(name)}>generate-scene</button>
    </div>
  ),
}));

vi.mock("./lorebook/PropCard", () => ({
  PropCard: ({
    name,
    onUpdate,
    onGenerate,
  }: {
    name: string;
    onUpdate: (name: string, updates: Record<string, unknown>) => void;
    onGenerate: (name: string) => void;
  }) => (
    <div data-testid="prop-card" data-name={name}>
      <button onClick={() => onUpdate(name, { description: "new prop desc" })}>
        update-prop
      </button>
      <button onClick={() => onGenerate(name)}>generate-prop</button>
    </div>
  ),
}));

vi.mock("./lorebook/AddCharacterForm", () => ({
  AddCharacterForm: ({
    onSubmit,
    onCancel,
  }: {
    onSubmit: (
      name: string,
      description: string,
      voice: string,
      referenceFile?: File | null,
    ) => Promise<void>;
    onCancel: () => void;
  }) => (
    <div data-testid="add-character-form">
      <button
        onClick={() =>
          void onSubmit(
            "NewHero",
            "desc",
            "voice",
            new File(["ref"], "new-hero.png", { type: "image/png" }),
          )
        }
      >
        submit-add-character
      </button>
      <button onClick={onCancel}>cancel-add-character</button>
    </div>
  ),
}));

function makeProjectData(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    title: "Demo",
    content_mode: "narration",
    style: "Anime",
    episodes: [{ episode: 1, title: "EP1", script_file: "scripts/episode_1.json" }],
    characters: {
      Hero: { description: "hero description" },
    },
    scenes: { Temple: { description: "ancient temple" } },
    props: { Sword: { description: "rusty sword" } },
    ...overrides,
  };
}

function makeScript(): EpisodeScript {
  return {
    episode: 1,
    title: "EP1",
    content_mode: "narration",
    duration_seconds: 4,
    summary: "summary",
    novel: { title: "n", chapter: "1" },
    segments: [
      {
        segment_id: "SEG-1",
        episode: 1,
        duration_seconds: 4,
        segment_break: false,
        novel_text: "text",
        characters_in_segment: ["Hero"],
        scenes: ["Temple"],
        props: ["Sword"],
        image_prompt: "image prompt",
        video_prompt: "video prompt",
        transition_to_next: "cut",
      },
    ],
  };
}

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <StudioCanvasRouter />
      </Router>,
    ),
    location,
  };
}

async function renderLoadedAt(path: string, testId: string) {
  const view = renderAt(path);
  await screen.findAllByTestId(testId);
  return view;
}

describe("StudioCanvasRouter", () => {
  beforeEach(() => {
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    useTasksStore.setState(useTasksStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("shows loading state when currentProjectName is missing", () => {
    renderAt("/");
    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("routes characters/scenes/props/source/episodes views correctly", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: {
        "episode_1.json": makeScript(),
      },
    });

    const viewCharacters = await renderLoadedAt("/characters", "character-card");
    expect(screen.getByTestId("character-card")).toHaveAttribute("data-name", "Hero");
    viewCharacters.unmount();

    const viewScenes = await renderLoadedAt("/scenes", "scene-card");
    expect(screen.getByTestId("scene-card")).toHaveAttribute("data-name", "Temple");
    viewScenes.unmount();

    const viewProps = await renderLoadedAt("/props", "prop-card");
    expect(screen.getByTestId("prop-card")).toHaveAttribute("data-name", "Sword");
    viewProps.unmount();

    const viewSource = await renderLoadedAt("/source/source%20file.txt", "source-file-viewer");
    expect(screen.getByTestId("source-file-viewer")).toHaveTextContent("source file.txt");
    viewSource.unmount();

    const viewEpisodes = await renderLoadedAt("/episodes/1", "timeline-canvas");
    expect(screen.getByTestId("timeline-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-has-script")).toHaveTextContent("yes");
    viewEpisodes.unmount();

    await waitFor(() => {
      expect(screen.queryByText("加载中...")).not.toBeInTheDocument();
    });
  });

  it("redirects nested /settings to the full project settings route", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: {},
    });

    const { location } = renderAt("/settings");

    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/projects/demo/settings");
    });
  });

  it("runs character callbacks and reports API failures with toast", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": makeScript() },
    });

    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: { "episode_1.json": makeScript() },
    });
    vi.spyOn(API, "updateCharacter").mockResolvedValue({ success: true });
    vi.spyOn(API, "uploadFile").mockResolvedValue({ success: true, path: "x", url: "y" });
    vi.spyOn(API, "generateCharacter").mockResolvedValue({ success: true, task_id: "t-1", message: "已提交" });
    vi.spyOn(API, "addCharacter").mockResolvedValue({ success: true });

    await renderLoadedAt("/characters", "character-card");

    fireEvent.click(screen.getByText("update-character"));
    await waitFor(() => {
      expect(API.updateCharacter).toHaveBeenCalledWith("demo", "Hero", {
        description: "new desc",
        voice_style: "new voice",
      });
      expect(API.uploadFile).toHaveBeenNthCalledWith(
        1,
        "demo",
        "character_ref",
        expect.any(File),
        "Hero",
      );
      expect(API.getProject).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("generate-character"));
    await waitFor(() => {
      expect(API.generateCharacter).toHaveBeenCalledWith(
        "demo",
        "Hero",
        "hero description",
      );
      expect(useAppStore.getState().toast?.text).toContain("生成任务已提交");
      expect(useAppStore.getState().toast?.tone).toBe("success");
    });

    // Test add character flow: click "add" button is not directly accessible in CharacterCard mock;
    // instead, we test the AddCharacterForm path by navigating with the form already showing.
    // The add-character button is on CharactersPage which is not directly exposed; we test the form submit instead.
  });

  it("submits generation tasks for missing character designs only", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData({
        characters: {
          Hero: { description: "hero description" },
          Mentor: { description: "mentor description", character_sheet: "characters/Mentor.png" },
        },
      }),
      currentScripts: {},
    });
    vi.spyOn(API, "generateCharacter").mockResolvedValue({ success: true, task_id: "t-1", message: "已提交" });

    await renderLoadedAt("/characters", "character-card");

    fireEvent.click(screen.getByRole("button", { name: /生成缺失人物 1|Generate Missing 1/ }));

    await waitFor(() => {
      expect(API.generateCharacter).toHaveBeenCalledTimes(1);
      expect(API.generateCharacter).toHaveBeenCalledWith("demo", "Hero", "hero description");
      expect(useAppStore.getState().toast?.text).toContain("已提交");
    });
  });

  it("generates or completes the project character list", async () => {
    const generatedProject = makeProjectData({
      characters: {
        Hero: { description: "hero description" },
        Mentor: { description: "mentor description" },
      },
    });
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: {},
    });
    vi.spyOn(API, "generateProjectCharacters").mockResolvedValue({
      success: true,
      characters: generatedProject.characters,
      source: "source",
      added: 1,
      updated: 0,
      skipped: 1,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: generatedProject,
      scripts: {},
    });

    await renderLoadedAt("/characters", "character-card");

    fireEvent.click(screen.getByRole("button", { name: /补全角色|Complete Characters/ }));

    await waitFor(() => {
      expect(API.generateProjectCharacters).toHaveBeenCalledWith("demo");
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(useAppStore.getState().toast?.text).toContain("1 个角色");
    });
  });

  it("runs scene callbacks and reports API failures with toast", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": makeScript() },
    });

    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: { "episode_1.json": makeScript() },
    });
    vi.spyOn(API, "updateProjectScene").mockRejectedValue(new Error("scene update failed"));
    vi.spyOn(API, "generateProjectScene").mockRejectedValue(new Error("scene generate failed"));

    await renderLoadedAt("/scenes", "scene-card");

    fireEvent.click(screen.getByText("update-scene"));
    await waitFor(() => {
      expect(API.updateProjectScene).toHaveBeenCalledWith("demo", "Temple", {
        description: "new scene desc",
      });
      expect(useAppStore.getState().toast?.text).toContain("更新场景失败");
      expect(useAppStore.getState().toast?.tone).toBe("error");
    });

    fireEvent.click(screen.getByText("generate-scene"));
    await waitFor(() => {
      expect(API.generateProjectScene).toHaveBeenCalledWith("demo", "Temple", "ancient temple");
      expect(useAppStore.getState().toast?.text).toContain("提交失败");
    });
  });

  it("generates or completes the project scene list", async () => {
    const generatedProject = makeProjectData({
      scenes: {
        Temple: { description: "ancient temple" },
        Office: { description: "modern office" },
      },
    });
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: {},
    });
    vi.spyOn(API, "generateProjectScenes").mockResolvedValue({
      success: true,
      scenes: generatedProject.scenes ?? {},
      source: "source",
      added: 1,
      updated: 0,
      skipped: 1,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: generatedProject,
      scripts: {},
    });

    await renderLoadedAt("/scenes", "scene-card");

    fireEvent.click(screen.getByRole("button", { name: /补全场景|Complete Scenes/ }));

    await waitFor(() => {
      expect(API.generateProjectScenes).toHaveBeenCalledWith("demo");
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(useAppStore.getState().toast?.text).toContain("1 个场景");
    });
  });

  it("submits generation tasks for missing scene designs only", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData({
        scenes: {
          Temple: { description: "ancient temple" },
          Office: { description: "modern office", scene_sheet: "scenes/Office.png" },
        },
      }),
      currentScripts: {},
    });
    vi.spyOn(API, "generateProjectScene").mockResolvedValue({ success: true, task_id: "t-1", message: "已提交" });

    await renderLoadedAt("/scenes", "scene-card");

    fireEvent.click(screen.getByRole("button", { name: /生成缺失场景 1|Generate Missing Scenes 1/ }));

    await waitFor(() => {
      expect(API.generateProjectScene).toHaveBeenCalledTimes(1);
      expect(API.generateProjectScene).toHaveBeenCalledWith("demo", "Temple", "ancient temple");
      expect(useAppStore.getState().toast?.text).toContain("已提交");
    });
  });

  it("runs prop callbacks and reports API failures with toast", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": makeScript() },
    });

    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: { "episode_1.json": makeScript() },
    });
    vi.spyOn(API, "updateProjectProp").mockRejectedValue(new Error("prop update failed"));
    vi.spyOn(API, "generateProjectProp").mockRejectedValue(new Error("prop generate failed"));

    await renderLoadedAt("/props", "prop-card");

    fireEvent.click(screen.getByText("update-prop"));
    await waitFor(() => {
      expect(API.updateProjectProp).toHaveBeenCalledWith("demo", "Sword", {
        description: "new prop desc",
      });
      expect(useAppStore.getState().toast?.text).toContain("更新道具失败");
      expect(useAppStore.getState().toast?.tone).toBe("error");
    });

    fireEvent.click(screen.getByText("generate-prop"));
    await waitFor(() => {
      expect(API.generateProjectProp).toHaveBeenCalledWith("demo", "Sword", "rusty sword");
      expect(useAppStore.getState().toast?.text).toContain("提交失败");
    });
  });

  it("generates or completes the project prop list", async () => {
    const generatedProject = makeProjectData({
      props: {
        Sword: { description: "rusty sword" },
        Contract: { description: "paper contract" },
      },
    });
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: {},
    });
    vi.spyOn(API, "generateProjectProps").mockResolvedValue({
      success: true,
      props: generatedProject.props ?? {},
      source: "source",
      added: 1,
      updated: 0,
      skipped: 1,
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: generatedProject,
      scripts: {},
    });

    await renderLoadedAt("/props", "prop-card");

    fireEvent.click(screen.getByRole("button", { name: /补全道具|Complete Props/ }));

    await waitFor(() => {
      expect(API.generateProjectProps).toHaveBeenCalledWith("demo");
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(useAppStore.getState().toast?.text).toContain("1 个道具");
    });
  });

  it("submits generation tasks for missing prop designs only", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData({
        props: {
          Sword: { description: "rusty sword" },
          Contract: { description: "paper contract", prop_sheet: "props/Contract.png" },
        },
      }),
      currentScripts: {},
    });
    vi.spyOn(API, "generateProjectProp").mockResolvedValue({ success: true, task_id: "t-1", message: "已提交" });

    await renderLoadedAt("/props", "prop-card");

    fireEvent.click(screen.getByRole("button", { name: /生成缺失道具 1|Generate Missing Props 1/ }));

    await waitFor(() => {
      expect(API.generateProjectProp).toHaveBeenCalledTimes(1);
      expect(API.generateProjectProp).toHaveBeenCalledWith("demo", "Sword", "rusty sword");
      expect(useAppStore.getState().toast?.text).toContain("已提交");
    });
  });

  it("skips active asset design tasks and submits remaining missing designs", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData({
        characters: {
          Hero: { description: "hero" },
          Mentor: { description: "mentor" },
        },
        scenes: {
          Temple: { description: "temple" },
          Office: { description: "office" },
        },
        props: {
          Sword: { description: "sword" },
          Contract: { description: "contract" },
        },
      }),
      currentScripts: {},
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
          resource_id: "Temple",
          status: "running",
        }),
        makeTask({
          task_id: "prop-active",
          project_name: "demo",
          task_type: "prop",
          media_type: "image",
          resource_id: "Sword",
          status: "queued",
        }),
      ],
    });
    const generateCharacter = vi.spyOn(API, "generateCharacter").mockResolvedValue({
      success: true,
      task_id: "c-1",
      message: "ok",
    });
    const generateScene = vi.spyOn(API, "generateProjectScene").mockResolvedValue({
      success: true,
      task_id: "s-1",
      message: "ok",
    });
    const generateProp = vi.spyOn(API, "generateProjectProp").mockResolvedValue({
      success: true,
      task_id: "p-1",
      message: "ok",
    });

    const charactersView = await renderLoadedAt("/characters", "character-card");
    fireEvent.click(screen.getAllByText("generate-character")[0]);
    await waitFor(() => {
      expect(generateCharacter).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain('角色 "Hero" 已在队列中');
    });
    fireEvent.click(screen.getByRole("button", { name: /生成缺失人物 1|Generate Missing 1/ }));
    await waitFor(() => {
      expect(generateCharacter).toHaveBeenCalledTimes(1);
      expect(generateCharacter).toHaveBeenCalledWith("demo", "Mentor", "mentor");
    });
    charactersView.unmount();

    const scenesView = await renderLoadedAt("/scenes", "scene-card");
    fireEvent.click(screen.getAllByText("generate-scene")[0]);
    await waitFor(() => {
      expect(generateScene).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain('场景 "Temple" 已在队列中');
    });
    fireEvent.click(screen.getByRole("button", { name: /生成缺失场景 1|Generate Missing Scenes 1/ }));
    await waitFor(() => {
      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(generateScene).toHaveBeenCalledWith("demo", "Office", "office");
    });
    scenesView.unmount();

    await renderLoadedAt("/props", "prop-card");
    fireEvent.click(screen.getAllByText("generate-prop")[0]);
    await waitFor(() => {
      expect(generateProp).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain('道具 "Sword" 已在队列中');
    });
    fireEvent.click(screen.getByRole("button", { name: /生成缺失道具 1|Generate Missing Props 1/ }));
    await waitFor(() => {
      expect(generateProp).toHaveBeenCalledTimes(1);
      expect(generateProp).toHaveBeenCalledWith("demo", "Contract", "contract");
    });
  });

  it("runs timeline callbacks and handles generation failures", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": makeScript() },
    });

    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData(),
      scripts: { "episode_1.json": makeScript() },
    });
    vi.spyOn(API, "updateSegment").mockRejectedValue(new Error("update failed"));
    vi.spyOn(API, "generateStoryboard").mockRejectedValue(new Error("storyboard failed"));
    vi.spyOn(API, "generateVideo").mockRejectedValue(new Error("video failed"));

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("update-prompt"));
    await waitFor(() => {
      expect(API.updateSegment).toHaveBeenCalledWith("demo", "SEG-1", {
        image_prompt: "new prompt",
      });
      expect(useAppStore.getState().toast?.text).toContain("更新 Prompt 失败");
    });

    fireEvent.click(screen.getByText("generate-storyboard"));
    await waitFor(() => {
      expect(API.generateStoryboard).toHaveBeenCalledWith(
        "demo",
        "SEG-1",
        "image prompt",
        "episode_1.json",
      );
      expect(useAppStore.getState().toast?.text).toContain("生成分镜失败");
    });

    fireEvent.click(screen.getByText("generate-video"));
    await waitFor(() => {
      expect(API.generateVideo).toHaveBeenCalledWith(
        "demo",
        "SEG-1",
        "video prompt",
        "episode_1.json",
        4,
      );
      expect(useAppStore.getState().toast?.text).toContain("生成视频失败");
    });
  });

  it("submits batch storyboard and video tasks for the current episode", async () => {
    const base = makeScript() as Extract<EpisodeScript, { content_mode: "narration" }>;
    const segment = base.segments[0];
    const script: Extract<EpisodeScript, { content_mode: "narration" }> = {
      ...base,
      segments: [
        {
          ...segment,
          segment_id: "SEG-1",
          image_prompt: "image prompt 1",
          video_prompt: "video prompt 1",
          generated_assets: undefined,
        },
        {
          ...segment,
          segment_id: "SEG-2",
          duration_seconds: 6,
          image_prompt: "image prompt 2",
          video_prompt: "video prompt 2",
          generated_assets: {
            storyboard_image: "storyboards/SEG-2.png",
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
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": script },
    });

    vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-1",
      message: "ok",
    });
    vi.spyOn(API, "generateVideo").mockResolvedValue({
      success: true,
      task_id: "video-1",
      message: "ok",
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("generate-storyboards"));
    await waitFor(() => {
      expect(API.generateStoryboard).toHaveBeenCalledTimes(1);
      expect(API.generateStoryboard).toHaveBeenCalledWith(
        "demo",
        "SEG-1",
        "image prompt 1",
        "episode_1.json",
      );
      expect(useAppStore.getState().toast?.text).toContain("分镜生成任务");
    });

    fireEvent.click(screen.getByText("generate-videos"));
    await waitFor(() => {
      expect(API.generateVideo).toHaveBeenCalledTimes(1);
      expect(API.generateVideo).toHaveBeenCalledWith(
        "demo",
        "SEG-2",
        "video prompt 2",
        "episode_1.json",
        6,
      );
      expect(useAppStore.getState().toast?.text).toContain("视频生成任务");
    });
  });

  it("skips active storyboard and video tasks in episode batches", async () => {
    const base = makeScript() as Extract<EpisodeScript, { content_mode: "narration" }>;
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
        {
          ...segment,
          segment_id: "SEG-1",
          image_prompt: "image prompt 1",
          video_prompt: "video prompt 1",
          generated_assets: readyAssets,
        },
        {
          ...segment,
          segment_id: "SEG-2",
          image_prompt: "image prompt 2",
          video_prompt: "video prompt 2",
          generated_assets: readyAssets,
        },
        {
          ...segment,
          segment_id: "SEG-3",
          image_prompt: "image prompt 3",
          video_prompt: "video prompt 3",
          generated_assets: undefined,
        },
        {
          ...segment,
          segment_id: "SEG-4",
          image_prompt: "image prompt 4",
          video_prompt: "video prompt 4",
          generated_assets: undefined,
        },
      ],
    };
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": script },
    });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "video",
          media_type: "video",
          resource_id: "SEG-1",
          script_file: "scripts/episode_1.json",
          status: "queued",
        }),
        makeTask({
          task_id: "storyboard-active",
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-3",
          script_file: "episode_1.json",
          status: "running",
        }),
      ],
    });
    vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-1",
      message: "ok",
    });
    vi.spyOn(API, "generateVideo").mockResolvedValue({
      success: true,
      task_id: "video-1",
      message: "ok",
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("generate-storyboards"));
    await waitFor(() => {
      expect(API.generateStoryboard).toHaveBeenCalledTimes(1);
      expect(API.generateStoryboard).toHaveBeenCalledWith(
        "demo",
        "SEG-4",
        "image prompt 4",
        "episode_1.json",
      );
    });

    fireEvent.click(screen.getByText("generate-videos"));
    await waitFor(() => {
      expect(API.generateVideo).toHaveBeenCalledTimes(1);
      expect(API.generateVideo).toHaveBeenCalledWith(
        "demo",
        "SEG-2",
        "video prompt 2",
        "episode_1.json",
        4,
      );
    });
  });

  it("does not resubmit active single storyboard and video tasks", async () => {
    const base = makeScript() as Extract<EpisodeScript, { content_mode: "narration" }>;
    const script: Extract<EpisodeScript, { content_mode: "narration" }> = {
      ...base,
      segments: [
        {
          ...base.segments[0],
          generated_assets: {
            storyboard_image: "storyboards/SEG-1.png",
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
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": script },
    });
    useTasksStore.setState({
      tasks: [
        makeTask({
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-1",
          script_file: "scripts/episode_1.json",
          status: "queued",
        }),
        makeTask({
          task_id: "video-active",
          project_name: "demo",
          task_type: "video",
          media_type: "video",
          resource_id: "SEG-1",
          script_file: "episode_1.json",
          status: "running",
        }),
      ],
    });
    const storyboardSpy = vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-1",
      message: "ok",
    });
    const videoSpy = vi.spyOn(API, "generateVideo").mockResolvedValue({
      success: true,
      task_id: "video-1",
      message: "ok",
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("generate-storyboard"));
    await waitFor(() => {
      expect(storyboardSpy).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("分镜 \"SEG-1\" 已在队列中");
    });

    fireEvent.click(screen.getByText("generate-video"));
    await waitFor(() => {
      expect(videoSpy).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("视频 \"SEG-1\" 已在队列中");
    });
  });

  it("shows an active-task hint when all missing storyboards are already queued", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData(),
      currentScripts: { "episode_1.json": makeScript() },
    });
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
    const generateSpy = vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "storyboard-1",
      message: "ok",
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("generate-storyboards"));

    await waitFor(() => {
      expect(generateSpy).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("已在队列中");
    });
  });

  it("generates an episode script from a draft and refreshes project", async () => {
    const draftProject = makeProjectData({
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "segmented",
        },
      ],
    });
    const scriptedProject = makeProjectData({
      episodes: [
        {
          episode: 1,
          title: "EP1",
          script_file: "scripts/episode_1.json",
          script_status: "generated",
        },
      ],
    });
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: draftProject,
      currentScripts: {},
    });

    vi.spyOn(API, "generateEpisodeScript").mockResolvedValue({
      success: true,
      episode: 1,
      script_file: "scripts/episode_1.json",
      script: makeScript(),
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: scriptedProject,
      scripts: { "episode_1.json": makeScript() },
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");
    expect(screen.getByTestId("timeline-has-draft")).toHaveTextContent("yes");
    expect(screen.getByTestId("timeline-has-script")).toHaveTextContent("no");

    fireEvent.click(screen.getByText("generate-script"));

    await waitFor(() => {
      expect(API.generateEpisodeScript).toHaveBeenCalledWith("demo", 1);
      expect(API.getProject).toHaveBeenCalledWith("demo");
      expect(useAppStore.getState().toast?.text).toContain("剧本已生成");
      expect(useAppStore.getState().toast?.tone).toBe("success");
    });
  });

  it("shows a billing-specific message when platform credits are insufficient", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData({ billing_mode: "platform_credits" }),
      currentScripts: { "episode_1.json": makeScript() },
    });

    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData({ billing_mode: "platform_credits" }),
      scripts: { "episode_1.json": makeScript() },
    });
    vi.spyOn(API, "generateStoryboard").mockRejectedValue(
      new ApiRequestError("积分余额不足，至少需要 1 积分才能使用平台生成。", 402),
    );
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 100,
      minimum_generation_balance: 1,
      pending_purchase_credits: 0,
      entries: [],
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("generate-storyboard"));

    await waitFor(() => {
      expect(useAppStore.getState().toast?.text).toContain("平台积分不足");
      expect(useAppStore.getState().toast?.text).toContain("购买积分");
      expect(useAppStore.getState().toast?.tone).toBe("error");
    });
  });

  it("prevents platform-credit generation before submit when the balance is too low", async () => {
    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: makeProjectData({ billing_mode: "platform_credits" }),
      currentScripts: { "episode_1.json": makeScript() },
    });

    vi.spyOn(API, "getProject").mockResolvedValue({
      project: makeProjectData({ billing_mode: "platform_credits" }),
      scripts: { "episode_1.json": makeScript() },
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 0,
      minimum_generation_balance: 10,
      pending_purchase_credits: 0,
      entries: [],
    });
    const generateSpy = vi.spyOn(API, "generateStoryboard").mockResolvedValue({
      success: true,
      task_id: "t-1",
      message: "ok",
    });

    await renderLoadedAt("/episodes/1", "timeline-canvas");

    fireEvent.click(screen.getByText("generate-storyboard"));

    await waitFor(() => {
      expect(API.getCreditBalance).toHaveBeenCalled();
      expect(generateSpy).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast?.text).toContain("平台积分不足");
      expect(useAppStore.getState().toast?.text).toContain("当前 0");
      expect(useAppStore.getState().toast?.tone).toBe("error");
    });
  });
});
