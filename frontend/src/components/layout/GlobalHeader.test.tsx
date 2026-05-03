import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { GlobalHeader } from "@/components/layout/GlobalHeader";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useAssistantStore } from "@/stores/assistant-store";
import { useAuthStore } from "@/stores/auth-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import { useUsageStore } from "@/stores/usage-store";
import type { EpisodeScript } from "@/types";

vi.mock("@/components/task-hud/TaskHud", () => ({
  TaskHud: ({ defaultTab }: { defaultTab?: "tasks" | "credits" }) => (
    <div data-testid="task-hud" data-default-tab={defaultTab ?? "tasks"} />
  ),
}));

vi.mock("./UsageDrawer", () => ({
  UsageDrawer: () => <div data-testid="usage-drawer" />,
}));

vi.mock("./WorkspaceNotificationsDrawer", () => ({
  WorkspaceNotificationsDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="notifications-drawer" /> : null,
}));

vi.mock("./ExportScopeDialog", () => ({
  ExportScopeDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onClose: () => void;
    onSelect: (scope: "current" | "full") => void;
    anchorRef: React.RefObject<HTMLElement | null>;
    episodes?: unknown[];
    onJianyingExport?: (episode: number, draftPath: string, jianyingVersion: string) => void;
    jianyingExporting?: boolean;
  }) =>
    open ? (
      <div data-testid="export-scope-dialog">
        <button data-testid="scope-current" onClick={() => onSelect("current")}>
          仅当前版本
        </button>
        <button data-testid="scope-full" onClick={() => onSelect("full")}>
          全部数据
        </button>
      </div>
    ) : null,
}));

function renderHeader(path = "/characters") {
  const location = memoryLocation({ path, record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <GlobalHeader />
      </Router>,
    ),
    location,
  };
}

describe("GlobalHeader", () => {
  beforeEach(() => {
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAssistantStore.setState(useAssistantStore.getInitialState(), true);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useTasksStore.setState(useTasksStore.getInitialState(), true);
    useUsageStore.setState(useUsageStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 0, minimum_generation_balance: 1, pending_purchase_credits: 0, entries: [] });
    vi.spyOn(API, "getCreditReconciliation").mockResolvedValue({
      ok: true,
      checked_entries: 0,
      checked_tasks: 0,
      checked_api_calls: 0,
      issues: [],
    });
  });

  it("logs out from the workspace header", () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    useAuthStore.setState({
      token: "token-demo",
      username: "alice",
      isAuthenticated: true,
      isLoading: false,
    });

    renderHeader();
    screen.getByRole("button", { name: "登出" }).click();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("prefers the project title over the internal project name", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });

    useProjectsStore.setState({
      currentProjectName: "halou-92d19a04",
      currentProjectData: {
        title: "哈喽项目",
        content_mode: "narration",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();

    expect(screen.getByText("哈喽项目")).toBeInTheDocument();
    expect(screen.queryByText("halou-92d19a04")).not.toBeInTheDocument();
    expect(screen.getByText("自己填 API")).toBeInTheDocument();

    await waitFor(() => {
      expect(API.getUsageStats).toHaveBeenCalledWith({
        projectName: "halou-92d19a04",
      });
    });
  });

  it("shows the project aspect ratio independently from the content mode", () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });

    useProjectsStore.setState({
      currentProjectName: "short-drama",
      currentProjectData: {
        title: "短剧项目",
        content_mode: "drama",
        aspect_ratio: "9:16",
        style: "Drama",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();

    expect(screen.getByText("剧集动画 9:16")).toBeInTheDocument();
    expect(screen.queryByText("剧集动画 16:9")).not.toBeInTheDocument();
  });

  it("shows unread notification count and opens the drawer", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });

    useAppStore.getState().pushWorkspaceNotification({
      text: "AI 刚更新了道具「玉佩」，点击查看",
      target: {
        type: "prop",
        id: "玉佩",
        route: "/props",
      },
    });

    renderHeader();

    expect(screen.getByTitle("会话通知: 1 条")).toBeInTheDocument();
    screen.getByRole("button", { name: "打开通知中心" }).click();
    expect(await screen.findByTestId("notifications-drawer")).toBeInTheDocument();
  });

  it("exports the current project zip via browser-native download", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.spyOn(API, "requestExportToken").mockResolvedValue({
      download_token: "test-download-token",
      expires_in: 300,
      diagnostics: {
        blocking: [],
        auto_fixed: [{ code: "current_asset_restored_from_version", message: "修复视频引用" }],
        warnings: [],
      },
      delivery_report: null,
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "导出项目",
        content_mode: "narration",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();
    // Click export button to open dialog
    screen.getByRole("button", { name: "导出当前项目 ZIP" }).click();

    // Wait for dialog to appear then click "仅当前版本"
    const scopeBtn = await screen.findByTestId("scope-current");
    scopeBtn.click();

    await waitFor(() => {
      expect(API.requestExportToken).toHaveBeenCalledWith("demo", "current");
    });
    expect(anchorClick).toHaveBeenCalled();
    expect(useAppStore.getState().toast?.text).toContain("包含 1 条检查提醒");
  });

  it("uses backend export preflight before downloading from the global header", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.spyOn(API, "requestExportToken").mockResolvedValue({
      download_token: "test-download-token",
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

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "导出项目",
        content_mode: "narration",
        style: "Anime",
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
        ],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();
    screen.getByRole("button", { name: "导出当前项目 ZIP" }).click();
    const scopeBtn = await screen.findByTestId("scope-current");
    scopeBtn.click();

    expect(await screen.findByText("导出前检查")).toBeInTheDocument();
    expect(screen.getByText("1 个视频未生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去处理" })).toBeInTheDocument();
    expect(anchorClick).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "仍然导出" }).click();

    await waitFor(() => {
      expect(API.requestExportToken).toHaveBeenCalledWith("demo", "current");
      expect(anchorClick).toHaveBeenCalled();
    });
  });

  it("checks project delivery before exporting from the global header", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.spyOn(API, "requestExportToken").mockResolvedValue({
      download_token: "test-download-token",
      expires_in: 300,
      diagnostics: {
        blocking: [],
        auto_fixed: [],
        warnings: [],
      },
      delivery_report: null,
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const script = {
      episode: 1,
      title: "EP1",
      content_mode: "narration",
      duration_seconds: 8,
      summary: "summary",
      novel: { title: "Demo", chapter: "1" },
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
    } as EpisodeScript;

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "导出项目",
        content_mode: "narration",
        style: "Anime",
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
        characters: {},
        scenes: {},
        props: {},
      },
      currentScripts: { "scripts/episode_1.json": script },
    });

    renderHeader();
    screen.getByRole("button", { name: "导出当前项目 ZIP" }).click();
    const scopeBtn = await screen.findByTestId("scope-current");
    scopeBtn.click();

    expect(await screen.findByText("导出前检查")).toBeInTheDocument();
    expect(screen.getByText("视频未齐 1/2")).toBeInTheDocument();
    expect(API.requestExportToken).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "仍然导出" }).click();

    await waitFor(() => {
      expect(API.requestExportToken).toHaveBeenCalledWith("demo", "current");
      expect(anchorClick).toHaveBeenCalled();
    });
  });

  it("renders asset library button", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });

    renderHeader();

    expect(screen.getByRole("button", { name: "资产库" })).toBeInTheDocument();
  });

  it("navigates to the current workflow next step", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "工作流项目",
        content_mode: "narration",
        style: "Anime",
        overview: {
          synopsis: "summary",
          genre: "fantasy",
          theme: "growth",
          world_setting: "palace",
        },
        status: {
          current_phase: "production",
          phase_progress: 0.5,
          characters: { total: 1, completed: 1 },
          scenes: { total: 1, completed: 1 },
          props: { total: 0, completed: 0 },
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
        characters: {},
        scenes: {},
        props: {},
      },
    });

    const { location } = renderHeader();

    screen.getByRole("button", { name: "下一步" }).click();

    expect(location.history?.at(-1)).toBe("/episodes/1");
  });

  it("hides the workflow next shortcut when it would only reopen the current overview", () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "Setup Project",
        content_mode: "narration",
        style: "Anime",
        status: {
          current_phase: "setup",
          phase_progress: 0,
          characters: { total: 0, completed: 0 },
          scenes: { total: 0, completed: 0 },
          props: { total: 0, completed: 0 },
          episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
        },
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader("/");

    expect(screen.queryByRole("button", { name: "下一步" })).not.toBeInTheDocument();
  });

  it("shows credit balance and a buy credits shortcut for platform-credit projects", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 1200, minimum_generation_balance: 1, pending_purchase_credits: 800, entries: [] });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "平台项目",
        content_mode: "narration",
        billing_mode: "platform_credits",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    const { location } = renderHeader();

    expect(await screen.findByText("积分：1,200")).toBeInTheDocument();
    expect(screen.getByText("待到账：800 积分")).toBeInTheDocument();
    expect(screen.getByText("平台积分")).toBeInTheDocument();
    expect(API.getCreditBalance).toHaveBeenCalled();

    screen.getByRole("button", { name: "购买积分" }).click();

    expect(location.history?.at(-1)).toBe("/app/projects?buyCredits=1");
  });

  it("highlights billing reconciliation issues on the task hud trigger", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.mocked(API.getCreditReconciliation).mockResolvedValue({
      ok: false,
      checked_entries: 1,
      checked_tasks: 1,
      checked_api_calls: 0,
      issues: [
        {
          severity: "error",
          code: "stale_generation_reservation",
          title: "非进行中任务仍冻结积分",
          detail: "任务状态为 failed，但预计积分仍处于冻结中。",
          reference_type: "task",
          reference_id: "task-1",
        },
      ],
    });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "平台项目",
        content_mode: "narration",
        billing_mode: "platform_credits",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();

    const taskButton = await screen.findByRole("button", { name: "切换任务面板，计费异常 1 个" });
    expect(taskButton).toHaveAttribute("title", "任务状态: 0 运行中, 0 排队中；计费异常 1 个");
    expect(screen.getByTitle("计费异常 1 个")).toHaveTextContent("1");

    taskButton.click();

    await waitFor(() => {
      expect(screen.getByTestId("task-hud")).toHaveAttribute("data-default-tab", "credits");
    });
  });

  it("refreshes the billing issue badge when reconciliation is invalidated", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.mocked(API.getCreditReconciliation)
      .mockResolvedValueOnce({
        ok: false,
        checked_entries: 1,
        checked_tasks: 1,
        checked_api_calls: 0,
        issues: [
          {
            severity: "warning",
            code: "usage_task_unmatched",
            title: "扣费流水找不到匹配任务",
            detail: "这笔实际扣费带有资源 ID，但当前任务表中找不到匹配任务。",
          },
        ],
      })
      .mockResolvedValue({
        ok: true,
        checked_entries: 1,
        checked_tasks: 1,
        checked_api_calls: 0,
        issues: [],
      });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "平台项目",
        content_mode: "narration",
        billing_mode: "platform_credits",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();

    expect(await screen.findByRole("button", { name: "切换任务面板，计费异常 1 个" })).toBeInTheDocument();

    act(() => {
      useAppStore.getState().invalidateCreditReconciliation();
    });

    await waitFor(() => expect(API.getCreditReconciliation).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "切换任务面板" })).toHaveAttribute(
        "title",
        "任务状态: 0 运行中, 0 排队中",
      );
    });
    expect(screen.queryByTitle("计费异常 1 个")).not.toBeInTheDocument();
  });

  it("refreshes platform credit balance when queued task stats change", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    const balanceSpy = vi.spyOn(API, "getCreditBalance")
      .mockResolvedValueOnce({
        balance: 1200,
        available_balance: 1200,
        minimum_generation_balance: 1,
        pending_purchase_credits: 0,
        entries: [],
      })
      .mockResolvedValueOnce({
        balance: 1200,
        available_balance: 1133,
        reserved_generation_credits: 67,
        minimum_generation_balance: 1,
        pending_purchase_credits: 0,
        entries: [],
      });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "平台项目",
        content_mode: "narration",
        billing_mode: "platform_credits",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();

    expect(await screen.findByText("积分：1,200")).toBeInTheDocument();
    useTasksStore.getState().setStats({
      queued: 1,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      total: 1,
    });

    expect(await screen.findByText("积分：1,133")).toBeInTheDocument();
    expect(screen.getByText("生成冻结：67 积分")).toBeInTheDocument();
    expect(balanceSpy).toHaveBeenCalledTimes(2);
  });

  it("warns when a platform-credit project is below the generation minimum", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 0,
      minimum_generation_balance: 10,
      pending_purchase_credits: 0,
      entries: [],
    });

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "低余额项目",
        content_mode: "narration",
        billing_mode: "platform_credits",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();

    expect(await screen.findByText("余额不足")).toBeInTheDocument();
    expect(screen.getByTitle("积分余额不足，生成至少需要 10 积分")).toBeInTheDocument();
  });

  it("shows an error toast when exporting fails", async () => {
    vi.spyOn(API, "getUsageStats").mockResolvedValue({
      total_cost: 0,
      image_count: 0,
      video_count: 0,
      failed_count: 0,
      total_count: 0,
    });
    vi.spyOn(API, "requestExportToken").mockRejectedValue(new Error("network"));

    useProjectsStore.setState({
      currentProjectName: "demo",
      currentProjectData: {
        title: "导出项目",
        content_mode: "narration",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
    });

    renderHeader();
    screen.getByRole("button", { name: "导出当前项目 ZIP" }).click();

    const scopeBtn = await screen.findByTestId("scope-full");
    scopeBtn.click();

    await waitFor(() => {
      expect(useAppStore.getState().toast?.text).toContain("导出失败");
    });
  });
});
