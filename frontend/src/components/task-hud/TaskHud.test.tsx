import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TaskHud, getTaskLocationTarget } from "./TaskHud";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import { makeTask } from "@/test/factories";
import type { TaskItem, TaskStats } from "@/types";

vi.mock("@/components/ui/Popover", () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="task-popover">{children}</div> : null,
}));

const emptyStats: TaskStats = {
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  total: 0,
};

const emptyCreditBalance = {
  balance: 0,
  available_balance: 0,
  reserved_generation_credits: 0,
  minimum_generation_balance: 1,
  pending_purchase_credits: 0,
  entries: [],
};

const emptyCreditReconciliation = {
  ok: true,
  checked_entries: 0,
  checked_tasks: 0,
  checked_api_calls: 0,
  issues: [],
};

const emptyCreditReconciliationAudits = {
  audits: [],
};

const emptyCreditReconciliationAudit = {
  id: 1,
  action: "release_stale_reservations",
  status: "completed",
  actor_user_id: "user-a",
  fixed_count: 0,
  skipped_count: 0,
  note: null,
  summary: "ok",
  snapshot: null,
  created_at: "2026-05-02T01:02:03Z",
};

function renderHud(tasks: TaskItem[]) {
  const location = memoryLocation({ path: "/app/projects", record: true });
  const anchorRef = { current: document.createElement("button") };
  useTasksStore.setState({ tasks, stats: { ...emptyStats, total: tasks.length } });
  useAppStore.setState({ taskHudOpen: true });

  render(
    <Router hook={location.hook}>
      <TaskHud anchorRef={anchorRef} />
    </Router>,
  );

  return { location };
}

describe("TaskHud", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState(useAppStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useTasksStore.setState(useTasksStore.getInitialState(), true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:reconciliation-report"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(API, "getCreditBalance").mockResolvedValue(emptyCreditBalance);
    vi.spyOn(API, "getCreditReconciliation").mockResolvedValue(emptyCreditReconciliation);
    vi.spyOn(API, "getCreditReconciliationAudits").mockResolvedValue(emptyCreditReconciliationAudits);
    vi.spyOn(API, "runCreditReconciliationAction").mockResolvedValue({
      action: "release_stale_reservations",
      fixed_count: 0,
      skipped_count: 0,
      released: [],
      audit: emptyCreditReconciliationAudit,
      message: "ok",
    });
    vi.spyOn(API, "addCreditReconciliationNote").mockResolvedValue({
      ...emptyCreditReconciliationAudit,
      action: "manual_note",
      note: "checked",
    });
    vi.spyOn(API, "acknowledgeCreditReconciliationIssue").mockResolvedValue({
      ...emptyCreditReconciliationAudit,
      action: "acknowledge_issue",
      note: "checked",
    });
    vi.spyOn(API, "reopenCreditReconciliationIssue").mockResolvedValue({
      ...emptyCreditReconciliationAudit,
      action: "reopen_issue",
      note: "reopen",
    });
  });

  it("locates segment generation tasks back to their episode timeline", () => {
    const { location } = renderHud([
      makeTask({
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo project",
        resource_id: "E2S03",
        script_file: "scripts/episode_2.json",
        status: "running",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /查看定位|View & Locate/ }));

    expect(location.history?.at(-1)).toBe("/app/projects/demo%20project/episodes/2");
    expect(useAppStore.getState().taskHudOpen).toBe(false);
    expect(useAppStore.getState().scrollTarget).toMatchObject({
      type: "segment",
      id: "E2S03",
      route: "~/app/projects/demo%20project/episodes/2",
    });
  });

  it("builds locations for project asset tasks", () => {
    expect(getTaskLocationTarget(makeTask({
      task_type: "character",
      media_type: "image",
      project_name: "demo project",
      resource_id: "Hero",
    }))).toMatchObject({
      type: "character",
      id: "Hero",
      route: "~/app/projects/demo%20project/characters",
    });

    expect(getTaskLocationTarget(makeTask({
      task_type: "reference_video",
      media_type: "video",
      project_name: "demo project",
      resource_id: "E1U1",
    }))).toMatchObject({
      type: "reference-unit",
      id: "E1U1",
      route: "~/app/projects/demo%20project/episodes/1",
    });

    expect(getTaskLocationTarget(makeTask({
      task_type: "grid",
      media_type: "image",
      project_name: "demo project",
      resource_id: "grid_1",
      script_file: "scripts/episode_3.json",
      payload: { scene_ids: ["SEG-1"] },
    }))).toMatchObject({
      type: "segment",
      id: "SEG-1",
      route: "~/app/projects/demo%20project/episodes/3",
    });
  });

  it("retries failed tasks from the hud", async () => {
    const retrySpy = vi.spyOn(API, "retryTask").mockResolvedValue({
      task_id: "new-task",
      status: "queued",
      deduped: false,
      existing_task_id: null,
    });

    renderHud([
      makeTask({
        task_id: "failed-task",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S01",
        script_file: "scripts/episode_1.json",
        status: "failed",
        error_message: "provider timeout",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /重试此任务|Retry this task/ }));

    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith("failed-task"));
    expect(useAppStore.getState().toast).toMatchObject({
      text: expect.stringMatching(/重新加入|generation queue/),
      tone: "success",
    });
  });

  it("batch retries and copies failed tasks from the current filter", async () => {
    const retrySpy = vi.spyOn(API, "retryTask").mockImplementation(async (taskId) => ({
      task_id: `${taskId}-retry`,
      status: "queued",
      deduped: taskId === "failed-deduped",
      existing_task_id: taskId === "failed-deduped" ? "existing-task" : null,
    }));

    renderHud([
      makeTask({
        task_id: "failed-video",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S01",
        status: "failed",
        error_message: "provider timeout",
      }),
      makeTask({
        task_id: "failed-deduped",
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo",
        resource_id: "E1S02",
        status: "failed",
        error_message: "duplicate request",
      }),
      makeTask({
        task_id: "queued-task",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S03",
        status: "queued",
      }),
    ]);

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "video" } });

    await waitFor(() => expect(screen.queryByText("E1S02")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重试失败任务 1" }));

    await waitFor(() => expect(retrySpy).toHaveBeenCalledTimes(1));
    expect(retrySpy).toHaveBeenCalledWith("failed-video");
    expect(useAppStore.getState().toast).toMatchObject({
      text: expect.stringContaining("新入队 1 个"),
      tone: "success",
    });

    fireEvent.click(screen.getByRole("button", { name: "复制失败报告" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] ?? "";
    expect(copied).toContain("# Scenelet 失败任务报告");
    expect(copied).toContain("task_id: failed-video");
    expect(copied).toContain("provider timeout");
    expect(copied).not.toContain("failed-deduped");
  });

  it("batch cancels queued tasks from the current filter after confirmation", async () => {
    const cancelSpy = vi.spyOn(API, "cancelTask").mockResolvedValue({
      cancelled: [],
      skipped_running: [],
    });

    renderHud([
      makeTask({
        task_id: "queued-video",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S01",
        status: "queued",
      }),
      makeTask({
        task_id: "queued-storyboard",
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo",
        resource_id: "E1S02",
        status: "queued",
      }),
    ]);

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "storyboard" } });
    await waitFor(() => expect(screen.queryByText("E1S01")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "取消排队 1" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("当前筛选下 1 个排队任务");

    fireEvent.click(screen.getByRole("button", { name: "确认取消" }));

    await waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));
    expect(cancelSpy).toHaveBeenCalledWith("queued-storyboard");
    expect(useAppStore.getState().toast).toMatchObject({
      text: expect.stringContaining("已处理 1 个"),
      tone: "success",
    });
  });

  it("filters the unified task center by status and task type", async () => {
    renderHud([
      makeTask({
        task_id: "failed-video",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S01",
        status: "failed",
        error_message: "provider timeout",
      }),
      makeTask({
        task_id: "queued-storyboard",
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo",
        resource_id: "E1S02",
        status: "queued",
      }),
    ]);

    expect(screen.getByText("E1S01")).toBeInTheDocument();
    expect(screen.getByText("E1S02")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "failed" } });

    expect(screen.getByText("E1S01")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("E1S02")).not.toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "storyboard" } });

    await waitFor(() => expect(screen.queryByText("E1S01")).not.toBeInTheDocument());
    expect(screen.getByText("暂无任务")).toBeInTheDocument();
  });

  it("searches tasks and can limit results to the current project", async () => {
    useProjectsStore.setState({ currentProjectName: "demo" });
    renderHud([
      makeTask({
        task_id: "demo-task",
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo",
        resource_id: "E1S01",
        status: "queued",
      }),
      makeTask({
        task_id: "other-task",
        task_type: "video",
        media_type: "video",
        project_name: "other-project",
        resource_id: "E9S01",
        status: "queued",
        payload: {
          model_rule_summary: {
            media_type: "video",
            rule_target: "__media__/video",
            mode: "github_skill",
            target_label: "Runway · gen-4",
            skill_name: "travel-cam",
          },
        },
      }),
    ]);

    expect(screen.getByText("E1S01")).toBeInTheDocument();
    expect(screen.getAllByText("E9S01").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("搜索任务"), { target: { value: "runway" } });

    await waitFor(() => expect(screen.queryByText("E1S01")).not.toBeInTheDocument());
    expect(screen.getAllByText("E9S01").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("E1S01")).toBeInTheDocument();
    expect(screen.getAllByText("E9S01").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/只看当前项目/));

    expect(screen.getByText("E1S01")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("E9S01")).not.toBeInTheDocument());
  });

  it("shows the model rule summary recorded on queued tasks", () => {
    const { location } = renderHud([
      makeTask({
        task_id: "queued-image",
        task_type: "character",
        media_type: "image",
        project_name: "demo",
        resource_id: "Alice",
        status: "queued",
        payload: {
          model_rule_summary: {
            media_type: "image",
            rule_target: "__media__/image",
            mode: "prompt",
            target_label: "OpenAI · gpt-image-2",
            skill_name: "travel-style",
            billing_mode: "platform_credits",
          },
        },
      }),
    ]);

    expect(screen.getByText(/图像生成规则：添加 Prompt · OpenAI · gpt-image-2 · travel-style/)).toBeInTheDocument();
    expect(screen.getByText("规则")).toBeInTheDocument();
    expect(screen.getByText("模型")).toBeInTheDocument();
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("扣费")).toBeInTheDocument();
    expect(screen.getByText("travel-style")).toBeInTheDocument();
    expect(screen.getAllByText("平台积分").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "打开规则" })[0]);

    expect(location.history?.at(-1)).toBe("/app/settings?section=media&ruleTarget=__media__%2Fimage");
  });

  it("shows a copyable model rule audit list for filtered tasks", async () => {
    renderHud([
      makeTask({
        task_id: "task-video",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S01",
        status: "succeeded",
        payload: {
          model_rule_summary: {
            media_type: "video",
            rule_target: "__media__/video",
            mode: "github_skill",
            target_label: "Runway · gen-4",
            skill_name: "cinematic-skill",
            billing_mode: "byok",
          },
        },
      }),
      makeTask({
        task_id: "task-image",
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo",
        resource_id: "E1S02",
        status: "queued",
        payload: {
          model_rule_summary: {
            media_type: "image",
            rule_target: "__media__/image",
            mode: "prompt",
            target_label: "OpenAI · gpt-image-2",
            billing_mode: "platform_credits",
          },
        },
      }),
      makeTask({
        task_id: "task-without-rule",
        task_type: "scene",
        media_type: "image",
        project_name: "demo",
        resource_id: "Lobby",
        status: "queued",
      }),
    ]);

    expect(screen.getByText("规则审计")).toBeInTheDocument();
    expect(screen.getByText("2 条")).toBeInTheDocument();
    expect(screen.getByText("Skill：cinematic-skill")).toBeInTheDocument();
    expect(screen.getAllByText("平台积分").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "复制审计" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain("# 规则审计");
    expect(copied).toContain("task_id: task-video");
    expect(copied).toContain("rule: 导入 GitHub Skill");
    expect(copied).toContain("rule_target: __media__/image");
  });

  it("focuses a requested task when opened from an audit preview", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    useAppStore.getState().triggerTaskHudFocus("target-task");

    renderHud([
      makeTask({
        task_id: "other-task",
        task_type: "storyboard",
        media_type: "image",
        project_name: "demo",
        resource_id: "E1S01",
        status: "queued",
      }),
      makeTask({
        task_id: "target-task",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S02",
        status: "succeeded",
      }),
    ]);

    const targetRow = screen.getByText("E1S02").closest("[data-task-id]");
    expect(targetRow).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().taskHudFocusTarget).toBeNull());
  });

  it("shows credit balance, reserved credits, and recent ledger entries", async () => {
    const creditSpy = vi.mocked(API.getCreditBalance).mockResolvedValue({
      balance: 1000,
      available_balance: 880,
      reserved_generation_credits: 120,
      minimum_generation_balance: 1,
      pending_purchase_credits: 300,
      entries: [
        {
          id: 1,
          amount: -120,
          kind: "generation_reservation",
          status: "reserved",
          reference_type: "task",
          reference_id: "task-video-1",
          description: "Reserve video generation",
          metadata: null,
          created_at: "2026-05-02T01:02:03Z",
        },
        {
          id: 2,
          amount: -80,
          kind: "generation_usage",
          status: "posted",
          reference_type: "task",
          reference_id: "task-video-0",
          description: "Video generation usage",
          metadata: null,
          created_at: "2026-05-02T01:00:00Z",
        },
      ],
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));

    await waitFor(() => expect(creditSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByText("880")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("Reserve video generation")).toBeInTheDocument();
    expect(screen.getByText("Video generation usage")).toBeInTheDocument();
    expect(screen.getAllByText("-120").length).toBeGreaterThan(0);
  });

  it("shows billing reconciliation issues in the credits tab", async () => {
    vi.mocked(API.getCreditReconciliation).mockResolvedValue({
      ok: false,
      checked_entries: 3,
      checked_tasks: 2,
      checked_api_calls: 1,
      issues: [
        {
          severity: "error",
          code: "stale_generation_reservation",
          title: "非进行中任务仍冻结积分",
          detail: "任务状态为 succeeded，但预计积分仍处于冻结中。",
          suggestion: "可一键释放这笔无效冻结。",
          action: "release_stale_reservations",
          action_label: "一键释放无效冻结",
          reference_type: "task",
          reference_id: "task-1",
          project_name: "demo",
          task_id: "task-1",
          task_status: "succeeded",
          resource_id: "E1S01",
          ledger_entry_id: 77,
          amount: 67,
          created_at: "2026-05-02T01:02:03Z",
        },
      ],
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));

    expect(await screen.findByText("计费健康检查")).toBeInTheDocument();
    expect(screen.getByText("1 个异常")).toBeInTheDocument();
    expect(screen.getByText("非进行中任务仍冻结积分")).toBeInTheDocument();
    expect(screen.getByText("stale_generation_reservation")).toBeInTheDocument();
    expect(screen.getByText(/可一键释放这笔无效冻结/)).toBeInTheDocument();
    expect(screen.getByText("#77")).toBeInTheDocument();
    expect(screen.getByText("E1S01")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键释放无效冻结" })).toBeInTheDocument();
  });

  it("opens and copies reconciliation issue locators", async () => {
    vi.mocked(API.getCreditReconciliation).mockResolvedValue({
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
          reference_type: "api_call",
          reference_id: "99",
          project_name: "demo project",
          resource_id: "E2S03",
          ledger_entry_id: 77,
          api_call_id: 99,
          amount: 42,
          created_at: "2026-05-02T01:02:03Z",
        },
      ],
    });

    const { location } = renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));

    expect(await screen.findByText("demo project")).toBeInTheDocument();
    expect(screen.getByText("E2S03")).toBeInTheDocument();
    expect(screen.getByText("#99")).toBeInTheDocument();
    expect(screen.getByText("#77")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制定位" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("project=demo project")));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("ledger=77"));
    expect(useAppStore.getState().toast).toMatchObject({
      text: "对账定位已复制",
      tone: "success",
    });

    fireEvent.click(screen.getByRole("button", { name: "打开分集" }));

    expect(location.history?.at(-1)).toBe("/app/projects/demo%20project/episodes/2");
    expect(useAppStore.getState().taskHudOpen).toBe(false);
    expect(useAppStore.getState().scrollTarget).toMatchObject({
      type: "segment",
      id: "E2S03",
      route: "~/app/projects/demo%20project/episodes/2",
    });
  });

  it("copies and exports reconciliation reports", async () => {
    vi.mocked(API.getCreditReconciliation).mockResolvedValue({
      ok: false,
      checked_entries: 4,
      checked_tasks: 2,
      checked_api_calls: 1,
      issues: [
        {
          severity: "warning",
          code: "usage_task_unmatched",
          title: "扣费流水找不到匹配任务",
          detail: "这笔实际扣费带有资源 ID，但当前任务表中找不到匹配任务。",
          suggestion: "确认是否保留为历史扣费。",
          reference_type: "api_call",
          reference_id: "99",
          project_name: "demo project",
          resource_id: "E2S03",
          ledger_entry_id: 77,
          api_call_id: 99,
          amount: 42,
          created_at: "2026-05-02T01:02:03Z",
        },
      ],
    });
    vi.mocked(API.getCreditReconciliationAudits).mockResolvedValue({
      audits: [
        {
          ...emptyCreditReconciliationAudit,
          action: "manual_note",
          note: "已核对",
        },
      ],
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制报告" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Scenelet 对账健康报告")));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("usage_task_unmatched"));
    expect(useAppStore.getState().toast).toMatchObject({
      text: "对账报告已复制",
      tone: "success",
    });

    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));

    const createObjectURL = vi.mocked(URL.createObjectURL);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    await expect(blob.text()).resolves.toContain("usage_task_unmatched");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reconciliation-report");
    expect(useAppStore.getState().toast).toMatchObject({
      text: "对账 CSV 已导出",
      tone: "success",
    });
  });

  it("acknowledges manual reconciliation issues", async () => {
    const reconciliationSpy = vi.mocked(API.getCreditReconciliation)
      .mockResolvedValueOnce({
        ok: false,
        checked_entries: 1,
        checked_tasks: 0,
        checked_api_calls: 0,
        issues: [
          {
            severity: "warning",
            code: "usage_task_unmatched",
            title: "扣费流水找不到匹配任务",
            detail: "这笔实际扣费带有资源 ID，但当前任务表中找不到匹配任务。",
            suggestion: "确认无误后可保留为历史扣费凭证。",
            reference_type: "task",
            reference_id: "task-1",
            project_name: "demo",
            amount: 42,
            created_at: "2026-05-02T01:02:03Z",
          },
        ],
      })
      .mockResolvedValue(emptyCreditReconciliation);
    const ackSpy = vi.mocked(API.acknowledgeCreditReconciliationIssue).mockResolvedValue({
      ...emptyCreditReconciliationAudit,
      action: "acknowledge_issue",
      note: "已人工确认：扣费流水找不到匹配任务",
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));
    fireEvent.click(await screen.findByRole("button", { name: "标记已确认" }));

    await waitFor(() => expect(ackSpy).toHaveBeenCalledWith({
      note: "已人工确认：扣费流水找不到匹配任务",
      issue_code: "usage_task_unmatched",
      reference_type: "task",
      reference_id: "task-1",
      project_name: "demo",
      task_id: null,
    }));
    await waitFor(() => expect(reconciliationSpy).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().toast).toMatchObject({
      text: "对账异常已标记为已确认",
      tone: "success",
    });
  });

  it("shows acknowledged reconciliation issues without blocking health", async () => {
    vi.mocked(API.getCreditReconciliation).mockResolvedValue({
      ok: true,
      checked_entries: 1,
      checked_tasks: 0,
      checked_api_calls: 0,
      issues: [
        {
          severity: "warning",
          code: "usage_task_unmatched",
          title: "扣费流水找不到匹配任务",
          detail: "这笔实际扣费带有资源 ID，但当前任务表中找不到匹配任务。",
          acknowledged: true,
          acknowledged_at: "2026-05-02T01:02:03Z",
          acknowledged_by: "user-a",
          acknowledgement_note: "已人工确认可保留",
          reference_type: "task",
          reference_id: "task-1",
          project_name: "demo",
        },
      ],
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));

    expect(await screen.findByText("正常")).toBeInTheDocument();
    expect(screen.getByText("当前筛选下没有异常")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已确认 1" }));

    expect(screen.getByText("已确认")).toBeInTheDocument();
    expect(screen.getByText(/已人工确认可保留/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记已确认" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销确认" })).toBeInTheDocument();
  });

  it("reopens acknowledged reconciliation issues", async () => {
    const reconciliationSpy = vi.mocked(API.getCreditReconciliation)
      .mockResolvedValueOnce({
        ok: true,
        checked_entries: 1,
        checked_tasks: 0,
        checked_api_calls: 0,
        issues: [
          {
            severity: "warning",
            code: "usage_task_unmatched",
            title: "扣费流水找不到匹配任务",
            detail: "这笔实际扣费带有资源 ID，但当前任务表中找不到匹配任务。",
            acknowledged: true,
            acknowledged_at: "2026-05-02T01:02:03Z",
            acknowledged_by: "user-a",
            acknowledgement_note: "已人工确认可保留",
            reference_type: "task",
            reference_id: "task-1",
            project_name: "demo",
          },
        ],
      })
      .mockResolvedValue(emptyCreditReconciliation);
    const reopenSpy = vi.mocked(API.reopenCreditReconciliationIssue).mockResolvedValue({
      ...emptyCreditReconciliationAudit,
      action: "reopen_issue",
      note: "撤销确认，重新处理：扣费流水找不到匹配任务",
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));
    fireEvent.click(await screen.findByRole("button", { name: "已确认 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销确认" }));

    await waitFor(() => expect(reopenSpy).toHaveBeenCalledWith({
      note: "撤销确认，重新处理：扣费流水找不到匹配任务",
      issue_code: "usage_task_unmatched",
      reference_type: "task",
      reference_id: "task-1",
      project_name: "demo",
      task_id: null,
    }));
    await waitFor(() => expect(reconciliationSpy).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().toast).toMatchObject({
      text: "已撤销确认，对账异常重新打开",
      tone: "success",
    });
  });

  it("runs a one-click reconciliation fix and refreshes credits", async () => {
    const reconciliationSpy = vi.mocked(API.getCreditReconciliation)
      .mockResolvedValueOnce({
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
            suggestion: "可一键释放这笔无效冻结。",
            action: "release_stale_reservations",
            action_label: "一键释放无效冻结",
            reference_type: "task",
            reference_id: "task-1",
            task_id: "task-1",
            task_status: "failed",
            amount: 67,
            created_at: "2026-05-02T01:02:03Z",
          },
        ],
      })
      .mockResolvedValue(emptyCreditReconciliation);
    const fixSpy = vi.mocked(API.runCreditReconciliationAction).mockResolvedValue({
      action: "release_stale_reservations",
      fixed_count: 1,
      skipped_count: 0,
      released: [],
      audit: {
        ...emptyCreditReconciliationAudit,
        fixed_count: 1,
      },
      message: "fixed",
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));
    fireEvent.click(await screen.findByRole("button", { name: "一键释放无效冻结" }));

    await waitFor(() => expect(fixSpy).toHaveBeenCalledWith({ action: "release_stale_reservations" }));
    await waitFor(() => expect(reconciliationSpy).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().toast).toMatchObject({
      text: "已处理 1 条异常冻结，跳过 0 条进行中冻结",
      tone: "success",
    });
    expect(useAppStore.getState().creditReconciliationRevision).toBe(1);
  });

  it("shows reconciliation audit history and saves manual notes", async () => {
    vi.mocked(API.getCreditReconciliationAudits).mockResolvedValue({
      audits: [
        {
          ...emptyCreditReconciliationAudit,
          fixed_count: 2,
          skipped_count: 1,
          note: "夜间对账已确认",
        },
      ],
    });
    const noteSpy = vi.mocked(API.addCreditReconciliationNote).mockResolvedValue({
      ...emptyCreditReconciliationAudit,
      action: "manual_note",
      note: "已人工核查",
    });

    renderHud([]);

    fireEvent.click(screen.getByRole("button", { name: "积分明细" }));

    expect(await screen.findByText("处理历史")).toBeInTheDocument();
    expect(screen.getByText("释放 2 条无效冻结，跳过 1 条")).toBeInTheDocument();
    expect(screen.getByText("夜间对账已确认")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("添加本次对账备注..."), {
      target: { value: "已人工核查" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));

    await waitFor(() => expect(noteSpy).toHaveBeenCalledWith({ note: "已人工核查" }));
    expect(useAppStore.getState().toast).toMatchObject({
      text: "对账备注已保存",
      tone: "success",
    });
  });

  it("shows credit entries directly on matching task rows", async () => {
    vi.mocked(API.getCreditBalance).mockResolvedValue({
      balance: 1000,
      available_balance: 880,
      reserved_generation_credits: 120,
      minimum_generation_balance: 1,
      pending_purchase_credits: 0,
      entries: [
        {
          id: 1,
          amount: -120,
          kind: "generation_reservation",
          status: "pending",
          reference_type: "task",
          reference_id: "task-video-1",
          description: "demo video reservation",
          metadata: null,
          created_at: "2026-05-02T01:02:03Z",
        },
        {
          id: 2,
          amount: -80,
          kind: "generation_usage",
          status: "posted",
          reference_type: "api_call",
          reference_id: "42",
          description: "demo video usage",
          metadata: {
            project_name: "demo",
            resource_id: "E1S01",
            call_type: "video",
          },
          created_at: "2026-05-02T01:03:03Z",
        },
      ],
    });

    renderHud([
      makeTask({
        task_id: "task-video-1",
        task_type: "video",
        media_type: "video",
        project_name: "demo",
        resource_id: "E1S01",
        status: "running",
      }),
    ]);

    await waitFor(() => expect(screen.getByText("冻结 120")).toBeInTheDocument());
    expect(screen.getByText("已扣 80")).toBeInTheDocument();
  });
});
