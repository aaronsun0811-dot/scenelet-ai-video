import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { AssetLibraryPage } from "@/components/pages/AssetLibraryPage";
import { useAppStore } from "@/stores/app-store";
import { useAssetsStore } from "@/stores/assets-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useProjectsStore } from "@/stores/projects-store";

vi.mock("@/components/pages/CreateProjectModal", () => ({
  CreateProjectModal: () => <div data-testid="create-project-modal">Create Project Modal</div>,
}));

function renderPage(path = "/app/assets") {
  const location = memoryLocation({ path, record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <AssetLibraryPage />
      </Router>,
    ),
    location,
  };
}

describe("AssetLibraryPage", () => {
  beforeEach(() => {
    useAssetsStore.setState({ byType: { character: [], scene: [], prop: [] } });
    useConfigStatusStore.setState(useConfigStatusStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    vi.restoreAllMocks();
    window.localStorage.clear();

    vi.spyOn(API, "listAssets").mockResolvedValue({ items: [] });
    vi.spyOn(API, "getProviders").mockResolvedValue({
      providers: [
        {
          id: "gemini",
          display_name: "Gemini",
          description: "",
          status: "ready",
          media_types: ["image", "video", "text"],
          capabilities: [],
          configured_keys: ["api_key"],
          missing_keys: [],
          models: {},
        },
      ],
    });
    vi.spyOn(API, "listCustomProviders").mockResolvedValue({ providers: [] });
    vi.spyOn(API, "getSystemConfig").mockResolvedValue({
      settings: {
        default_video_backend: "gemini/veo-3",
        default_image_backend: "gemini/imagen-4",
        default_text_backend: "gemini/gemini-2.5-pro",
        text_backend_script: "",
        text_backend_overview: "",
        text_backend_style: "",
        video_generate_audio: true,
        anthropic_api_key: { is_set: true, masked: "sk-ant-***" },
        google_maps_api_key: { is_set: false, masked: null },
        anthropic_base_url: "",
        anthropic_model: "",
        agent_model_backend: "",
        anthropic_default_haiku_model: "",
        anthropic_default_opus_model: "",
        anthropic_default_sonnet_model: "",
        claude_code_subagent_model: "",
        agent_session_cleanup_delay_seconds: 300,
        agent_max_concurrent_sessions: 5,
        about_title: "",
        about_subtitle: "",
        about_body: "",
        about_contact_label: "",
        about_contact_url: "",
        model_rule_configs: {},
      },
      options: {
        video_backends: [],
        image_backends: [],
        text_backends: [],
        agent_backends: [],
      },
    });
  });

  it("shows the Scenelet logo and unified top navigation", async () => {
    renderPage();

    expect(screen.getByAltText("Scenelet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "顶部创作项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "顶部资产库" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(await screen.findByText("还没有人物资产")).toBeInTheDocument();
  });

  it("shows the unified left sidebar and can open the project creation modal", async () => {
    renderPage();

    expect(await screen.findByText("还没有人物资产")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏资产库" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "侧边栏创作项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏导入 ZIP" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏智能体设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏 API 令牌设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏语言" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "侧边栏创建项目" }));

    expect(screen.getByTestId("create-project-modal")).toBeInTheDocument();
  });

  it("routes top shortcuts to projects and settings", async () => {
    const { location } = renderPage();
    expect(await screen.findByText("还没有人物资产")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "顶部创作项目" }));
    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/projects");
    });

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/settings");
    });
  });

  it("applies travel reference query params and highlights the matching asset", async () => {
    vi.spyOn(API, "listAssets").mockImplementation(async (params) => ({
      items: params?.type === "scene" && params.q === "osaka-map"
        ? [{
          id: "scene-osaka",
          type: "scene",
          name: "osaka-map",
          description: "旅游参考街景",
          voice_style: "",
          image_path: "_global_assets/scene/osaka-map.png",
          source_project: "demo",
          updated_at: "2026-05-02T00:00:00+08:00",
        }]
        : [],
    }));

    const { location } = renderPage("/app/assets?type=scene&q=osaka-map&travelRef=travel_references%2Fosaka-map.png&targetProject=demo&focus=scene-osaka");

    await waitFor(() => {
      expect(API.listAssets).toHaveBeenCalledWith({ type: "scene", q: "osaka-map" });
    });
    expect(screen.getByDisplayValue("osaka-map")).toBeInTheDocument();
    expect(screen.getByText("来自旅游路线参考图")).toBeInTheDocument();
    expect(screen.getByText(/travel_references\/osaka-map\.png/)).toBeInTheDocument();
    expect(await screen.findByTestId("asset-card-scene-osaka")).toHaveClass("border-cyan-300/70");

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));

    expect(location.history?.at(-1)).toBe("/app/assets");
  });

  it("applies a highlighted travel reference asset back to the target project", async () => {
    vi.spyOn(API, "listAssets").mockImplementation(async (params) => ({
      items: params?.type === "scene" && params.q === "osaka-map"
        ? [{
          id: "scene-osaka",
          type: "scene",
          name: "osaka-map",
          description: "旅游参考街景",
          voice_style: "",
          image_path: "_global_assets/scene/osaka-map.png",
          source_project: "demo",
          updated_at: "2026-05-02T00:00:00+08:00",
        }]
        : [],
    }));
    vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [{ id: "scene-osaka", name: "osaka-map" }],
      skipped: [],
      failed: [],
    });

    const { location } = renderPage("/app/assets?type=scene&q=osaka-map&travelRef=travel_references%2Fosaka-map.png&targetProject=demo&focus=scene-osaka");

    await screen.findByTestId("asset-card-scene-osaka");
    fireEvent.click(screen.getByRole("button", { name: "应用回项目" }));

    await waitFor(() => {
      expect(API.applyAssetsToProject).toHaveBeenCalledWith({
        asset_ids: ["scene-osaka"],
        target_project: "demo",
        conflict_policy: "rename",
      });
      expect(location.history?.at(-1)).toBe("/app/projects/demo/scenes");
    });
    expect(useAppStore.getState().toast?.text).toContain("已把「osaka-map」应用到「demo」场景库");
    expect(useAppStore.getState().scrollTarget).toMatchObject({
      type: "scene",
      id: "osaka-map",
      route: "/scenes",
      highlight: true,
    });
  });
});
