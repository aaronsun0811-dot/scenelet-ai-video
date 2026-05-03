import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import "@/i18n";
import { API } from "@/api";
import * as providerModels from "@/utils/provider-models";
import { useAppStore } from "@/stores/app-store";
import { ProjectSettingsPage } from "@/components/pages/ProjectSettingsPage";

const FAKE_CONFIG = {
  options: { video_backends: [], image_backends: [], text_backends: [], provider_names: {} },
  settings: {
    default_video_backend: "",
    default_image_backend: "",
    text_backend_script: "",
    text_backend_overview: "",
    text_backend_style: "",
    google_maps_api_key: { is_set: false, masked: null },
  },
};

const FAKE_CONFIG_WITH_DEFAULTS = {
  options: {
    video_backends: ["gemini/veo-3"],
    image_backends: ["gemini/nano-banana"],
    text_backends: ["gemini/g25"],
    provider_names: { gemini: "Gemini" },
  },
  settings: {
    default_video_backend: "gemini/veo-3",
    default_image_backend: "gemini/nano-banana",
    text_backend_script: "gemini/g25",
    text_backend_overview: "gemini/g25",
    text_backend_style: "gemini/g25",
    google_maps_api_key: { is_set: false, masked: null },
  },
};

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <Route path="/app/projects/:projectName/settings" component={ProjectSettingsPage} />
      </Router>,
    ),
    location,
  };
}

describe("ProjectSettingsPage – style picker", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(FAKE_CONFIG as unknown as Awaited<ReturnType<typeof API.getSystemConfig>>);
    vi.spyOn(API, "getProjectMembers").mockResolvedValue({
      owner_user_id: "default",
      current_user_role: "owner",
      members: [],
    });
    vi.spyOn(API, "searchUsers").mockResolvedValue([]);
    vi.spyOn(providerModels, "getProviderModels").mockResolvedValue([]);
    vi.spyOn(providerModels, "getCustomProviderModels").mockResolvedValue([]);
  });

  it("shows the shared app sidebar inside project settings", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    expect(await screen.findByText("模型配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏创作项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏资产库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏导入 ZIP" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏创建项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏智能体设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏地图与旅游设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏语言" })).toBeInTheDocument();
  });

  it("loads a project with style_template_id and selects the matching template card by default", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        style_template_id: "live_zhang_yimou",
        style: "画风：参考张艺谋电影风格",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    await waitFor(() => {
      // Selected card has aria-pressed=true
      const selected = screen.getByRole("button", { name: /张艺谋/, pressed: true });
      expect(selected).toBeInTheDocument();
    });
  });

  it("loads a project with style_image and switches to custom tab with existing preview", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        style_image: "style_reference.png",
        style_description: "old desc",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    await waitFor(() => {
      const img = screen.getByAltText(/上传风格参考图|Upload style reference/) as HTMLImageElement;
      expect(img.src).toContain("/api/v1/files/demo/style_reference.png");
    });
  });

  it("clearing the reference image keeps save enabled and triggers clear PATCH", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        style_image: "style_reference.png",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    await waitFor(() => screen.getByAltText(/上传风格参考图|Upload style reference/));
    const removeBtn = screen.getByRole("button", { name: /^remove$/i });
    fireEvent.click(removeBtn);

    // 移除自定义图后 save 应可点：保存即清除后端残留 style_image / description
    const saveBtn = screen.getByRole("button", { name: /保存风格|Save style/ });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("demo", {
        style_template_id: null,
        clear_style_image: true,
      });
    });
  });

  it("clicking 取消风格 when project has a template sends clear PATCH", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        style_template_id: "live_premium_drama",
        style: "画风：...",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    // 等到 style picker 已经 mount（能找到保存按钮）
    await screen.findByRole("button", { name: /保存风格|Save style/ });

    const clearBtn = screen.getByRole("button", { name: /取消风格|Remove style/ });
    fireEvent.click(clearBtn);

    const saveBtn = screen.getByRole("button", { name: /保存风格|Save style/ });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("demo", {
        style_template_id: null,
        clear_style_image: true,
      });
    });
  });

  it("falls back to 9:16 aspect ratio highlight when project has no aspect_ratio set", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    const portrait = await screen.findByRole("radio", { name: /竖屏 9:16/ });
    expect(portrait).toBeChecked();
    const landscape = screen.getByRole("radio", { name: /横屏 16:9/ });
    expect(landscape).not.toBeChecked();
  });

  it("shows 'follow global default · provider · model' in model triggers when project has no model override", async () => {
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(
      FAKE_CONFIG_WITH_DEFAULTS as unknown as Awaited<ReturnType<typeof API.getSystemConfig>>,
    );
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    // Wait for config to load and a model trigger to render
    const imageTrigger = await screen.findByRole("combobox", { name: /图片模型/ });
    expect(imageTrigger).toHaveTextContent(/跟随全局默认/);
    expect(imageTrigger).toHaveTextContent(/nano-banana/);
  });

  it("saves a template change via PATCH style_template_id", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        style_template_id: "live_premium_drama",
        style: "...",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo", style_template_id: "live_zhang_yimou" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    const card = await screen.findByRole("button", { name: /张艺谋/ });
    fireEvent.click(card);

    const saveBtn = screen.getByRole("button", { name: /保存风格|Save style/ });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("demo", { style_template_id: "live_zhang_yimou" });
    });
  });

  it("switches generation_mode to reference_video and marks the save button enabled", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        generation_mode: "storyboard",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    // Wait for the generation mode selector to appear (3 radios total)
    const referenceVideoRadio = await screen.findByRole("radio", { name: /参考生视频|Reference-to-Video/i });
    expect(referenceVideoRadio).not.toBeChecked();

    fireEvent.click(referenceVideoRadio);

    // After switching to reference_video the radio should be checked (dirty state)
    expect(referenceVideoRadio).toBeChecked();

    // The main save button should be enabled (it is never disabled except while saving)
    const saveBtn = screen.getByRole("button", { name: /^(保存|Save)$/i });
    expect(saveBtn).not.toBeDisabled();
  });

  it("changing content type applies its aspect ratio and generation preset on save", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_type: "scene_sketch",
        content_mode: "drama",
        aspect_ratio: "16:9",
        generation_mode: "storyboard",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo", content_type: "ad_story" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    const adStoryRadio = await screen.findByRole("radio", { name: /广告剧情|Ad Story/ });
    fireEvent.click(adStoryRadio);
    expect(adStoryRadio).toBeChecked();
    expect(screen.getByRole("radio", { name: /竖屏 9:16|Portrait 9:16/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /参考生视频|Reference-to-Video/i })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /^(保存|Save)$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          content_type: "ad_story",
          aspect_ratio: "9:16",
          generation_mode: "reference_video",
        }),
      );
    });
  });

  it("saves travel video route settings and keeps portrait selectable", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_type: "travel_video",
        content_mode: "narration",
        aspect_ratio: "16:9",
        generation_mode: "reference_video",
        travel_video_settings: {
          origin: "难波站",
          destination: "黑门市场",
          route_source: "google_street_view",
          narration_language: "zh",
          target_duration: "45s",
          camera_style: "street_walk_turns",
          narrator_persona: "enthusiastic_guide",
          route_notes: "",
          character_notes: "",
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo", content_type: "travel_video" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    fireEvent.change(await screen.findByPlaceholderText(/大阪难波站|Namba Station/), { target: { value: "大阪难波站" } });
    fireEvent.change(screen.getByPlaceholderText(/黑门市场|Kuromon Market/), { target: { value: "道顿堀" } });
    fireEvent.change(screen.getByDisplayValue(/Google 街景\/地图|Google Street View/), { target: { value: "manual" } });
    fireEvent.change(screen.getByRole("combobox", { name: /目标时长|Target Duration/ }), {
      target: { value: "custom" },
    });
    fireEvent.change(await screen.findByPlaceholderText(/240/), {
      target: { value: "240" },
    });
    fireEvent.change(screen.getByPlaceholderText(/途经点|waypoints/), {
      target: { value: "从车站出口出发，经过商店街后右转。" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /竖屏 9:16|Portrait 9:16/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(保存|Save)$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          content_type: "travel_video",
          aspect_ratio: "9:16",
          generation_mode: "reference_video",
          travel_video_settings: expect.objectContaining({
            origin: "大阪难波站",
            destination: "道顿堀",
            route_source: "manual",
            route_notes: "从车站出口出发，经过商店街后右转。",
            target_duration: "custom",
            custom_duration_seconds: 240,
          }),
        }),
      );
    });
  });

  it("uploads multiple travel route reference images and saves them", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_type: "travel_video",
        content_mode: "narration",
        aspect_ratio: "16:9",
        generation_mode: "reference_video",
        travel_video_settings: {
          route_source: "reference_images",
          narration_language: "zh",
          target_duration: "45s",
          camera_style: "street_walk_turns",
          narrator_persona: "enthusiastic_guide",
          route_notes: "",
          character_notes: "",
          reference_images: [],
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const uploadSpy = vi.spyOn(API, "uploadFile")
      .mockResolvedValueOnce({
        success: true,
        path: "travel_references/a.png",
        url: "/api/v1/files/demo/travel_references/a.png",
      })
      .mockResolvedValueOnce({
        success: true,
        path: "travel_references/b.webp",
        url: "/api/v1/files/demo/travel_references/b.webp",
      });
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo", content_type: "travel_video" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    const input = await screen.findByLabelText(/上传参考图|Upload Reference Images/);
    fireEvent.change(input, {
      target: {
        files: [
          new File(["a"], "a.png", { type: "image/png" }),
          new File(["b"], "b.webp", { type: "image/webp" }),
        ],
      },
    });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findAllByAltText(/旅游路线参考图|Travel route reference image/)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /^(保存|Save)$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          travel_video_settings: expect.objectContaining({
            route_source: "reference_images",
            reference_images: ["travel_references/a.png", "travel_references/b.webp"],
          }),
        }),
      );
    });
  });

  it("caps travel route reference uploads at ten images", async () => {
    const existingRefs = Array.from({ length: 9 }, (_, index) => `travel_references/ref-${index + 1}.png`);
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_type: "travel_video",
        content_mode: "narration",
        aspect_ratio: "16:9",
        generation_mode: "reference_video",
        travel_video_settings: {
          route_source: "reference_images",
          reference_images: existingRefs,
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const uploadSpy = vi.spyOn(API, "uploadFile").mockResolvedValue({
      success: true,
      path: "travel_references/ref-10.png",
      url: "/api/v1/files/demo/travel_references/ref-10.png",
    });

    renderAt("/app/projects/demo/settings");

    const input = await screen.findByLabelText(/上传参考图|Upload Reference Images/);
    fireEvent.change(input, {
      target: {
        files: [
          new File(["a"], "a.png", { type: "image/png" }),
          new File(["b"], "b.webp", { type: "image/webp" }),
        ],
      },
    });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/已上传 10\/10|10\/10 uploaded/)).toBeInTheDocument();
  });

  it("previews and displays travel route nodes", async () => {
    vi.spyOn(API, "getSystemConfig").mockResolvedValue({
      ...FAKE_CONFIG,
      settings: {
        ...FAKE_CONFIG.settings,
        google_maps_api_key: { is_set: true, masked: "AIza***demo" },
      },
    } as unknown as Awaited<ReturnType<typeof API.getSystemConfig>>);
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_type: "travel_video",
        content_mode: "narration",
        aspect_ratio: "16:9",
        generation_mode: "reference_video",
        travel_video_settings: {
          origin: "大阪难波站",
          destination: "黑门市场",
          route_source: "google_street_view",
          narration_language: "zh",
          target_duration: "45s",
          camera_style: "street_walk_turns",
          narrator_persona: "enthusiastic_guide",
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:street-view"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const streetViewSpy = vi.spyOn(API, "fetchTravelRouteStreetView").mockResolvedValue(
      new Blob(["jpeg"], { type: "image/jpeg" }),
    );
    const previewSpy = vi.spyOn(API, "previewTravelRoute").mockResolvedValue({
      source: "google",
      google_configured: true,
      route_ready: true,
      origin: "大阪难波站",
      destination: "黑门市场",
      summary: "Sennichimae Dori",
      distance_text: "1.2 km",
      duration_text: "15 mins",
      reference_images: [],
      warnings: [],
      generated_at: "2026-05-02T00:00:00Z",
      nodes: [
        {
          id: "google-step-1",
          label: "路线节点 1",
          instruction: "Head east",
          lat: 34.665,
          lng: 135.501,
          street_view_status: "OK",
          pano_id: "pano-demo",
          source: "google",
        },
      ],
    });

    renderAt("/app/projects/demo/settings");

    fireEvent.click(await screen.findByRole("button", { name: /预检路线|Precheck Route/ }));

    await waitFor(() => {
      expect(previewSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          origin: "大阪难波站",
          destination: "黑门市场",
          route_source: "google_street_view",
        }),
      );
    });
    expect(await screen.findByText(/Sennichimae Dori/)).toBeInTheDocument();
    expect(screen.getByText("Head east")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(streetViewSpy).toHaveBeenCalledWith("demo", "google-step-1");
    expect(await screen.findByAltText(/街景缩略图|Street View thumbnail/)).toHaveAttribute("src", "blob:street-view");
  });

  it("renders reference-image route preview nodes as thumbnails", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_type: "travel_video",
        content_mode: "narration",
        aspect_ratio: "16:9",
        generation_mode: "reference_video",
        travel_video_settings: {
          route_source: "reference_images",
          reference_images: ["travel_references/map.png"],
          route_preview: {
            source: "reference_images",
            google_configured: false,
            route_ready: true,
            summary: "使用上传的路线参考图生成。",
            reference_images: ["travel_references/map.png"],
            warnings: [],
            nodes: [
              {
                id: "reference-1",
                label: "参考图 1",
                instruction: "travel_references/map.png",
                source: "reference_image",
              },
            ],
          },
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    const images = await screen.findAllByAltText(/旅游路线参考图|Travel route reference image/);
    expect(images.some((img) => img.getAttribute("src")?.includes("/api/v1/files/demo/travel_references/map.png"))).toBe(true);
  });

  it("saves the project-level character design style prompt", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        character_style_prompt: "旧人物风格",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo", character_style_prompt: "真人短剧质感" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    const textarea = await screen.findByLabelText(/角色设定图风格|Character Design Style/);
    fireEvent.change(textarea, { target: { value: " 真人短剧质感 " } });
    fireEvent.click(screen.getByRole("button", { name: /^(保存|Save)$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({ character_style_prompt: "真人短剧质感" }),
      );
    });
  });

  it("treats legacy implicit drama duration as auto", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_mode: "drama",
        default_duration: 8,
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    const autoRadio = await screen.findByRole("radio", { name: "auto" });
    expect(autoRadio).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "8s" })).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("button", { name: /^(保存|Save)$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({ default_duration: null }),
      );
    });
  });

  it("preserves an explicit drama duration selection", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        content_mode: "drama",
        default_duration: 8,
        default_duration_explicit: true,
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    expect(await screen.findByRole("radio", { name: "8s" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "auto" })).toHaveAttribute("aria-checked", "false");
  });

  it("defaults missing billing mode to BYOK and saves platform credits changes", async () => {
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 0, minimum_generation_balance: 1, pending_purchase_credits: 0, entries: [] });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo", billing_mode: "platform_credits" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    const byokRadio = await screen.findByRole("radio", { name: /自己填 API/ });
    const platformRadio = screen.getByRole("radio", { name: /平台积分/ });
    expect(byokRadio).toBeChecked();
    expect(platformRadio).not.toBeChecked();

    fireEvent.click(platformRadio);
    expect(platformRadio).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /^(保存|Save)$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({ billing_mode: "platform_credits" }),
      );
    });
  });

  it("shows balance and buy credits action for platform-credit projects", async () => {
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 1500,
      available_balance: 1433,
      minimum_generation_balance: 1,
      pending_purchase_credits: 600,
      reserved_generation_credits: 67,
      entries: [],
    });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        billing_mode: "platform_credits",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    const { location } = renderAt("/app/projects/demo/settings");

    expect(await screen.findByRole("radio", { name: /平台积分/ })).toBeChecked();
    expect(await screen.findByText("积分余额：1,433")).toBeInTheDocument();
    expect(screen.getByText("生成门槛：1 积分")).toBeInTheDocument();
    expect(screen.getByText("待到账：600 积分")).toBeInTheDocument();
    expect(screen.getByText("生成冻结：67 积分")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /购买积分/ }));

    expect(location.history?.at(-1)).toBe("/app/projects?buyCredits=1");
  });

  it("shows low-balance guidance for platform-credit projects", async () => {
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 0, minimum_generation_balance: 10, pending_purchase_credits: 0, entries: [] });
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        billing_mode: "platform_credits",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    expect(await screen.findByRole("radio", { name: /平台积分/ })).toBeChecked();
    expect(await screen.findByText("积分余额：0")).toBeInTheDocument();
    expect(screen.getByText("积分余额不足，生成至少需要 10 积分")).toBeInTheDocument();
  });

  it("lets the owner add and remove project members", async () => {
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    vi.spyOn(API, "getProjectMembers").mockResolvedValue({
      owner_user_id: "default",
      current_user_role: "owner",
      members: [],
    });
    const addSpy = vi.spyOn(API, "addProjectMember").mockResolvedValue({
      owner_user_id: "default",
      current_user_role: "owner",
      members: [{ user_id: "user-c", username: "carol", role: "editor" }],
    });
    const removeSpy = vi.spyOn(API, "deleteProjectMember").mockResolvedValue({
      owner_user_id: "default",
      current_user_role: "owner",
      members: [],
    });

    renderAt("/app/projects/demo/settings");

    expect(await screen.findByText("项目成员")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("用户名或用户 ID"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "添加成员" }));

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalledWith("demo", "carol", "editor");
    });
    expect(await screen.findByText("carol")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除成员 user-c" }));
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith("demo", "user-c");
    });
  });
});

describe("ProjectSettingsPage – model_settings resolution", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.spyOn(API, "getProjectMembers").mockResolvedValue({
      owner_user_id: "default",
      current_user_role: "owner",
      members: [],
    });
    vi.spyOn(API, "searchUsers").mockResolvedValue([]);
    vi.spyOn(providerModels, "getProviderModels").mockResolvedValue([]);
    vi.spyOn(providerModels, "getCustomProviderModels").mockResolvedValue([]);
  });

  it("loads existing model_settings resolution into video/image pickers", async () => {
    vi.spyOn(API, "getSystemConfig").mockResolvedValue({
      ...FAKE_CONFIG_WITH_DEFAULTS,
    } as unknown as Awaited<ReturnType<typeof API.getSystemConfig>>);
    // 提供含 resolutions 的 provider，使 ResolutionPicker 能够渲染
    vi.spyOn(providerModels, "getProviderModels").mockResolvedValue([
      {
        id: "gemini",
        display_name: "Gemini",
        description: "",
        status: "ready",
        media_types: ["video", "image"],
        capabilities: [],
        configured_keys: [],
        missing_keys: [],
        models: {
          "veo-3": {
            display_name: "Veo 3",
            media_type: "video",
            capabilities: [],
            default: true,
            supported_durations: [5, 8],
            duration_resolution_constraints: {},
            resolutions: ["720p", "1080p"],
          },
          "nano-banana": {
            display_name: "Nano Banana",
            media_type: "image",
            capabilities: [],
            default: true,
            supported_durations: [],
            duration_resolution_constraints: {},
            resolutions: ["720p", "1080p"],
          },
        },
      },
    ] as Awaited<ReturnType<typeof providerModels.getProviderModels>>);
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        video_backend: "gemini/veo-3",
        image_backend: "gemini/nano-banana",
        model_settings: {
          "gemini/veo-3": { resolution: "1080p" },
          "gemini/nano-banana": { resolution: "720p" },
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);

    renderAt("/app/projects/demo/settings");

    // 等待 ResolutionPicker 出现并验证已加载的初始值
    // select 模式的 ResolutionPicker 渲染为 <select>，当前值会是对应 option selected
    await waitFor(() => {
      const selects = screen.getAllByRole("combobox");
      // 找到视频分辨率 select（aria-label 为 "分辨率"）
      const resSelects = selects.filter((el) =>
        el.getAttribute("aria-label")?.includes("分辨率") || el.getAttribute("aria-label")?.includes("Resolution"),
      );
      expect(resSelects.length).toBeGreaterThan(0);
      // 验证已加载的值
      const values = resSelects.map((el) => (el as HTMLSelectElement).value);
      expect(values).toContain("1080p");
      expect(values).toContain("720p");
    });
  });

  it("saves resolution changes via updateProject with model_settings", async () => {
    vi.spyOn(API, "getSystemConfig").mockResolvedValue({
      ...FAKE_CONFIG_WITH_DEFAULTS,
    } as unknown as Awaited<ReturnType<typeof API.getSystemConfig>>);
    // getProject 会被 handleSave 内调用一次（获取 existingModelSettings），mock 始终返回相同 project
    vi.spyOn(API, "getProject").mockResolvedValue({
      project: {
        title: "Demo",
        video_backend: "gemini/veo-3",
        image_backend: "gemini/nano-banana",
        model_settings: {
          "gemini/veo-3": { resolution: "1080p" },
          "gemini/nano-banana": { resolution: "720p" },
        },
        episodes: [],
        characters: {},
        clues: {},
      },
      scripts: {},
    } as unknown as Awaited<ReturnType<typeof API.getProject>>);
    const updateSpy = vi.spyOn(API, "updateProject").mockResolvedValue({
      success: true,
      project: { title: "Demo" } as unknown as Awaited<ReturnType<typeof API.updateProject>>["project"],
    });

    renderAt("/app/projects/demo/settings");

    // 等配置加载完
    await screen.findByRole("radio", { name: /竖屏 9:16/ });

    const saveBtn = screen.getByRole("button", { name: /^(保存|Save)$/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          model_settings: expect.objectContaining({
            "gemini/veo-3": expect.objectContaining({ resolution: "1080p" }),
            "gemini/nano-banana": expect.objectContaining({ resolution: "720p" }),
          }),
        }),
      );
    });
  });
});
