import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub URL object APIs not available in jsdom
globalThis.URL.createObjectURL ??= vi.fn(() => "blob:mock");
globalThis.URL.revokeObjectURL ??= vi.fn();
import "@/i18n";
import { CreateProjectModal } from "./CreateProjectModal";
import { API } from "@/api";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";

// Mock wouter navigation
const navigateMock = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/app/projects", navigateMock],
}));

const mockSysConfig = {
  settings: {
    default_video_backend: "",
    default_image_backend: "",
    default_text_backend: "",
    text_backend_script: "",
    text_backend_overview: "",
    text_backend_style: "",
    video_generate_audio: false,
    anthropic_api_key: { is_set: false, masked: null },
    anthropic_base_url: "",
    anthropic_model: "",
    agent_model_backend: "",
    anthropic_default_haiku_model: "",
    anthropic_default_opus_model: "",
    anthropic_default_sonnet_model: "",
    claude_code_subagent_model: "",
    agent_session_cleanup_delay_seconds: 0,
    agent_max_concurrent_sessions: 0,
  },
  options: {
    video_backends: ["gemini-aistudio/veo-3"],
    image_backends: ["gemini-aistudio/nano-banana"],
    text_backends: ["gemini-aistudio/g25"],
    provider_names: { "gemini-aistudio": "Gemini AI Studio" },
  },
};

const mockProviders = {
  providers: [
    {
      id: "gemini-aistudio",
      display_name: "Gemini AI Studio",
      description: "",
      status: "ready" as const,
      media_types: ["video", "image", "text"],
      capabilities: [],
      configured_keys: [],
      missing_keys: [],
      models: {
        "veo-3": {
          display_name: "veo-3",
          media_type: "video",
          capabilities: [],
          default: false,
          supported_durations: [4, 6, 8],
          duration_resolution_constraints: {},
        },
      },
    },
  ],
};

describe("CreateProjectModal", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useProjectsStore.setState({ showCreateModal: true });
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(mockSysConfig as never);
    vi.spyOn(API, "getProviders").mockResolvedValue(mockProviders as never);
    vi.spyOn(API, "listCustomProviders").mockResolvedValue({ providers: [] });
    vi.spyOn(API, "createProject").mockResolvedValue({
      success: true,
      name: "demo-proj",
      project: {} as never,
    });
    vi.spyOn(API, "uploadStyleImage").mockResolvedValue({
      success: true,
      style_image: "",
      style_description: "",
      url: "",
    });
  });

  it("starts at step 1 and shows title input", () => {
    render(<CreateProjectModal />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // Next button disabled until title typed
    expect(screen.getByRole("button", { name: /下一步/ })).toBeDisabled();
  });

  it("advances from step 1 to step 2 after title entered and Next clicked", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    // Step 2 shows loading or Back button
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /上一步/ })).toBeInTheDocument()
    );
  });

  it("advances from step 2 to step 3 without validation", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ })); // to step 2
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    // Step 3: Create button appears
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
  });

  it("submits createProject with default template when Create clicked on step 3", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));
    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "demo",
        content_type: "scene_sketch",
        billing_mode: "byok",
        content_mode: "drama",
        aspect_ratio: "16:9",
        generation_mode: "storyboard",
        style_template_id: "content_scene_sketch",
        video_backend: null,
        image_backend: null,
        default_duration: 8,
      })
    );
    expect(navigateMock).toHaveBeenCalledWith("/app/projects/demo-proj?workflow=quickstart");
    expect(useAppStore.getState().toast?.text).toContain("项目已创建");
  });

  it("follows the content type default style until the user picks a custom template", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    const fictionOption = screen.getAllByText(/小说改编|Fiction Adaptation/)[0].closest("label");
    expect(fictionOption).not.toBeNull();
    fireEvent.click(fictionOption!);
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));
    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        content_type: "fiction_adaptation",
        style_template_id: "content_fiction_adaptation",
        default_duration: 8,
      })
    );
  });

  it("submits travel video route settings from the create flow", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox", { name: /项目标题|Project Title/ }), { target: { value: "travel demo" } });
    const travelOption = screen.getAllByText(/旅游视频|Travel Video/)[0].closest("label");
    expect(travelOption).not.toBeNull();
    fireEvent.click(travelOption!);
    fireEvent.change(screen.getByPlaceholderText(/大阪难波站|Namba Station/), {
      target: { value: "难波站" },
    });
    fireEvent.change(screen.getByPlaceholderText(/黑门市场|Kuromon Market/), {
      target: { value: "黑门市场" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /路线来源|Route Source/ }), {
      target: { value: "manual" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /目标时长|Target Duration/ }), {
      target: { value: "180s" },
    });
    fireEvent.change(screen.getByPlaceholderText(/途经点|waypoints|経由地/), {
      target: { value: "沿千日前通前进，看到商店街后右转。" },
    });

    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));

    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        content_type: "travel_video",
        aspect_ratio: "16:9",
        generation_mode: "reference_video",
        travel_video_settings: expect.objectContaining({
          origin: "难波站",
          destination: "黑门市场",
          route_source: "manual",
          route_notes: "沿千日前通前进，看到商店街后右转。",
          target_duration: "180s",
        }),
      }),
    );
  });

  it("submits custom travel video duration from the create flow", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox", { name: /项目标题|Project Title/ }), { target: { value: "long travel demo" } });
    const travelOption = screen.getAllByText(/旅游视频|Travel Video/)[0].closest("label");
    expect(travelOption).not.toBeNull();
    fireEvent.click(travelOption!);
    fireEvent.change(screen.getByRole("combobox", { name: /目标时长|Target Duration/ }), {
      target: { value: "custom" },
    });
    fireEvent.change(await screen.findByPlaceholderText(/240/), {
      target: { value: "360" },
    });

    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));

    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        content_type: "travel_video",
        travel_video_settings: expect.objectContaining({
          target_duration: "custom",
          custom_duration_seconds: 360,
        }),
      }),
    );
  });

  it("uploads travel video reference images during project creation", async () => {
    const refA = new File(["a"], "guide.png", { type: "image/png" });
    const refB = new File(["b"], "street.webp", { type: "image/webp" });
    const uploadSpy = vi.spyOn(API, "uploadFile")
      .mockResolvedValueOnce({
        success: true,
        path: "travel_references/guide.png",
        url: "/api/v1/files/demo-proj/travel_references/guide.png",
      })
      .mockResolvedValueOnce({
        success: true,
        path: "travel_references/street.webp",
        url: "/api/v1/files/demo-proj/travel_references/street.webp",
      });
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: {} as never,
    });

    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox", { name: /项目标题|Project Title/ }), { target: { value: "travel demo" } });
    const travelOption = screen.getAllByText(/旅游视频|Travel Video/)[0].closest("label");
    expect(travelOption).not.toBeNull();
    fireEvent.click(travelOption!);

    const uploadInput = await screen.findByLabelText(/上传参考图|Upload Reference Images/);
    fireEvent.change(uploadInput, {
      target: { files: [refA, refB] },
    });
    expect(await screen.findAllByAltText(/旅游路线参考图|Travel route reference image/)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2));
    expect(uploadSpy).toHaveBeenNthCalledWith(1, "demo-proj", "travel_reference", refA);
    expect(uploadSpy).toHaveBeenNthCalledWith(2, "demo-proj", "travel_reference", refB);
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo-proj",
        expect.objectContaining({
          travel_video_settings: expect.objectContaining({
            reference_images: ["travel_references/guide.png", "travel_references/street.webp"],
          }),
        }),
      );
    });
  });

  it("submits platform credits billing when selected on step 1", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByText(/平台积分|Platform Credits/));
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));
    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: "platform_credits" })
    );
  });

  it("goes back from step 2 to step 1 preserving title", async () => {
    render(<CreateProjectModal />);
    const titleInput = screen.getByRole("textbox");
    fireEvent.change(titleInput, { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /上一步/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /上一步/ }));
    // Back on step 1, title preserved
    expect(screen.getByRole("textbox")).toHaveValue("demo");
  });

  it("shows error toast and stays on step 3 when createProject fails", async () => {
    vi.spyOn(API, "createProject").mockRejectedValueOnce(new Error("boom"));
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));
    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    // Not navigated away
    expect(navigateMock).not.toHaveBeenCalled();
    // Create button re-enabled after failure (creating=false)
    await waitFor(() => expect(screen.getByRole("button", { name: /创建项目/ })).toBeEnabled());
  });

  it("calls uploadStyleImage after createProject when in custom mode with uploaded file", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument());

    // Switch to custom tab
    fireEvent.click(screen.getByRole("button", { name: /自定义|Custom/ }));
    // Upload a file via the hidden file input
    const file = new File(["content"], "style.png", { type: "image/png" });
    const fileInput = document.querySelector("input[type='file']") as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => expect(screen.getByRole("button", { name: /创建项目/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));

    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(expect.objectContaining({
      style_template_id: null,
    }));
    await waitFor(() => expect(API.uploadStyleImage).toHaveBeenCalledWith("demo-proj", file));
  });

  it("允许在 custom tab 未上传文件时创建项目（风格为可选）", async () => {
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /创建项目/ })).toBeInTheDocument());

    // Switch to custom tab WITHOUT uploading anything
    fireEvent.click(screen.getByRole("button", { name: /自定义|Custom/ }));

    // Create button should still be enabled — style is optional
    await waitFor(() => expect(screen.getByRole("button", { name: /创建项目/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));

    await waitFor(() => expect(API.createProject).toHaveBeenCalled());
    expect(API.createProject).toHaveBeenCalledWith(expect.objectContaining({
      style_template_id: null,
    }));
    // No upload since no file
    expect(API.uploadStyleImage).not.toHaveBeenCalled();
  });
});
