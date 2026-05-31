import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { AdminPage } from "@/components/pages/AdminPage";
import { useAuthStore } from "@/stores/auth-store";
import type { TaskItem } from "@/types";

function renderAdmin(path = "/app/admin") {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <AdminPage />
    </Router>,
  );
}

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    task_id: "task-1",
    project_name: "demo",
    task_type: "video",
    media_type: "video",
    resource_id: "seg-1",
    script_file: null,
    payload: {},
    status: "failed",
    result: null,
    error_message: "provider failed",
    cancelled_by: null,
    source: "webui",
    queued_at: "2026-01-01T00:00:00Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("AdminPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ isAuthenticated: true, isLoading: false, role: "admin" });
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Demo",
          style: "",
          thumbnail: null,
          status: {},
        },
      ],
    });
    vi.spyOn(API, "listUsers").mockResolvedValue([
      { id: "u1", username: "admin", role: "admin", is_active: true },
      { id: "u2", username: "alice", role: "user", is_active: true },
    ]);
    vi.spyOn(API, "getTaskStats").mockResolvedValue({
      stats: { queued: 1, running: 2, succeeded: 10, failed: 1, cancelled: 0, total: 14 },
    });
    vi.spyOn(API, "listTasks").mockResolvedValue({
      items: [makeTask()],
      total: 1,
      page: 1,
      page_size: 50,
    });
    vi.spyOn(API, "getCreditReconciliation").mockResolvedValue({
      ok: false,
      issues: [
        {
          severity: "error",
          code: "usage_task_unmatched",
          title: "Unmatched usage",
          detail: "usage mismatch",
          acknowledged: false,
        },
      ],
      checked_api_calls: 1,
      checked_entries: 2,
      checked_tasks: 3,
    });
    vi.spyOn(API, "getProviders").mockResolvedValue({
      providers: [
        {
          id: "openai",
          display_name: "OpenAI",
          description: "",
          status: "ready",
          media_types: ["image"],
          capabilities: [],
          configured_keys: ["OPENAI_API_KEY"],
          missing_keys: [],
          models: {},
        },
      ],
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 1200,
      available_balance: 1000,
      minimum_generation_balance: 1,
      pending_purchase_credits: 200,
      reserved_generation_credits: 0,
      entries: [],
    });
    vi.spyOn(API, "listCustomProviders").mockResolvedValue({ providers: [] });
    vi.spyOn(API, "listApiKeys").mockResolvedValue([]);
  });

  it("renders the standalone admin overview from existing operations APIs", async () => {
    renderAdmin();

    expect((await screen.findAllByText("管理后台")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(API.listUsers).toHaveBeenCalledWith("", 500);
      expect(API.listTasks).toHaveBeenCalledWith({ status: "failed", pageSize: 5 });
    });
    expect(screen.getAllByText("项目").length).toBeGreaterThan(0);
    expect(screen.getByText("近期失败任务")).toBeInTheDocument();
    expect(screen.getByText("provider failed")).toBeInTheDocument();
  });

  it("renders the task management view from the admin route section", async () => {
    renderAdmin("/app/admin?section=tasks");

    expect((await screen.findAllByText("失败")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(API.listTasks).toHaveBeenCalledWith({ status: "failed", pageSize: 50 });
    });
    expect(screen.getByText("demo / seg-1")).toBeInTheDocument();
  });

  it("renders platform API key management from the admin console", async () => {
    renderAdmin("/app/admin?section=api-keys");

    expect(await screen.findByText("API 密钥管理")).toBeInTheDocument();
    await waitFor(() => {
      expect(API.listApiKeys).toHaveBeenCalled();
    });
    expect(screen.getByText("暂无 API 密钥")).toBeInTheDocument();
  });
});
