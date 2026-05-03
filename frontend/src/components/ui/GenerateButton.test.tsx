import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import i18n from "@/i18n";
import { GenerateButton } from "./GenerateButton";

describe("GenerateButton", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage("zh");
  });

  it("uses the localized default loading label", async () => {
    await i18n.changeLanguage("en");

    render(<GenerateButton onClick={vi.fn()} loading label="Generate" />);

    expect(screen.getByRole("button", { name: /Generating/ })).toBeDisabled();
  });

  it("runs a generation preflight before confirming submission", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const preflightSpy = vi.spyOn(API, "requestGenerationPreflight").mockResolvedValue({
      project_name: "demo",
      task_type: "character",
      resource_id: "Alice",
      billing_mode: "platform_credits",
      required_credits: 12,
      count: 1,
      balance: 100,
      available_balance: 80,
      reserved_generation_credits: 20,
      minimum_generation_balance: 1,
      can_submit: true,
      blocking: [],
      warnings: [],
      checks: [
        {
          code: "model_rule_image",
          label: "生成规则",
          status: "ok",
          message: "生成图片将使用「导入 GitHub Skill」，目标模型：OpenAI · gpt-image-2，Skill：travel.md。",
          action_label: "打开模型规则",
          action_route: "/app/settings?section=media",
          action_kind: "model_rule_summary",
          action_payload: {
            media_type: "image",
            mode: "github_skill",
            target_label: "OpenAI · gpt-image-2",
            skill_name: "travel.md",
            billing_mode: "platform_credits",
          },
        },
        {
          code: "travel_route_preview_ready",
          label: "旅游路线",
          status: "ok",
          message: "路线已预检：大阪难波站 -> 黑门市场（1.2 km / 15 mins）",
        },
      ],
    });

    render(
      <GenerateButton
        onClick={onClick}
        label="生成"
        preflight={{
          projectName: "demo",
          taskType: "character",
          resourceId: "Alice",
          targetLabel: "Alice",
          payload: { prompt: "hero" },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /生成/ }));

    expect(preflightSpy).toHaveBeenCalledWith("demo", {
      task_type: "character",
      payload: { prompt: "hero" },
      resource_id: "Alice",
      count: 1,
    });
    expect(await screen.findByText("生成前检查")).toBeInTheDocument();
    expect(screen.getByText("12 积分")).toBeInTheDocument();
    expect(screen.getByText("链路检查")).toBeInTheDocument();
    expect(screen.getByText("生成规则")).toBeInTheDocument();
    expect(screen.getByText("导入 GitHub Skill")).toBeInTheDocument();
    expect(screen.getByText("OpenAI · gpt-image-2")).toBeInTheDocument();
    expect(screen.getByText("travel.md")).toBeInTheDocument();
    expect(screen.getByText("旅游路线")).toBeInTheDocument();
    expect(screen.getByText("路线已预检：大阪难波站 -> 黑门市场（1.2 km / 15 mins）")).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认提交" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("blocks confirmation when platform credits are insufficient", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    vi.spyOn(API, "requestGenerationPreflight").mockResolvedValue({
      project_name: "demo",
      task_type: "video",
      resource_id: "E1S01",
      billing_mode: "platform_credits",
      required_credits: 50,
      count: 1,
      balance: 20,
      available_balance: 20,
      reserved_generation_credits: 0,
      minimum_generation_balance: 1,
      can_submit: false,
      blocking: [{ code: "insufficient_platform_credits", message: "积分余额不足" }],
      warnings: [],
    });

    render(
      <GenerateButton
        onClick={onClick}
        label="生成视频"
        preflight={{
          projectName: "demo",
          taskType: "video",
          resourceId: "E1S01",
          payload: { duration_seconds: 8 },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /生成视频/ }));

    expect(await screen.findByText("积分余额不足")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "无法提交" })).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("navigates from a preflight check action", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const location = memoryLocation({ path: "/app/projects/demo/scenes", record: true });
    vi.spyOn(API, "requestGenerationPreflight").mockResolvedValue({
      project_name: "demo",
      task_type: "video",
      resource_id: "E1S01",
      billing_mode: "byok",
      required_credits: 0,
      count: 1,
      minimum_generation_balance: 1,
      can_submit: true,
      blocking: [],
      warnings: [{
        code: "travel_reference_scene_assets_incomplete",
        message: "旅游参考图已有 1/2 张应用为项目场景素材",
      }],
      checks: [
        {
          code: "travel_reference_scene_assets_incomplete",
          label: "参考图场景素材",
          status: "warning",
          message: "旅游参考图已有 1/2 张应用为项目场景素材",
          action_label: "打开路线交付清单",
          action_route: "/app/projects/demo?openTravelRouteAssets=1",
        },
      ],
    });

    render(
      <Router hook={location.hook}>
        <GenerateButton
          onClick={onClick}
          label="生成视频"
          preflight={{
            projectName: "demo",
            taskType: "video",
            resourceId: "E1S01",
            payload: { duration_seconds: 8 },
          }}
        />
      </Router>,
    );

    await user.click(screen.getByRole("button", { name: /生成视频/ }));
    await user.click(await screen.findByRole("button", { name: "打开路线交付清单" }));

    expect(location.history?.at(-1)).toBe("/app/projects/demo?openTravelRouteAssets=1");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies missing travel reference scene assets from a preflight check action", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const preflightSpy = vi.spyOn(API, "requestGenerationPreflight")
      .mockResolvedValueOnce({
        project_name: "demo",
        task_type: "video",
        resource_id: "E1S01",
        billing_mode: "byok",
        required_credits: 0,
        count: 1,
        minimum_generation_balance: 1,
        can_submit: true,
        blocking: [],
        warnings: [{
          code: "travel_reference_scene_assets_incomplete",
          message: "旅游参考图已有 0/1 张应用为项目场景素材",
        }],
        checks: [
          {
            code: "travel_reference_scene_assets_incomplete",
            label: "参考图场景素材",
            status: "warning",
            message: "旅游参考图已有 0/1 张应用为项目场景素材",
            action_label: "一键应用场景素材",
            action_route: "/app/projects/demo?openTravelRouteAssets=1",
            action_kind: "apply_travel_scene_assets",
            action_payload: {
              missing_reference_images: ["travel_references/street.png"],
              applied_reference_images: [],
              total_reference_images: 1,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        project_name: "demo",
        task_type: "video",
        resource_id: "E1S01",
        billing_mode: "byok",
        required_credits: 0,
        count: 1,
        minimum_generation_balance: 1,
        can_submit: true,
        blocking: [],
        warnings: [],
        checks: [
          {
            code: "travel_reference_scene_assets_ready",
            label: "参考图场景素材",
            status: "ok",
            message: "旅游参考图已全部应用为项目场景素材：1/1。",
          },
        ],
      });
    const addAssetSpy = vi.spyOn(API, "addAssetFromProjectFile").mockResolvedValue({
      asset: {
        id: "scene-street",
        type: "scene",
        name: "street",
        description: "",
        voice_style: "",
        image_path: "_global_assets/scene/street.png",
        source_project: "demo",
        updated_at: null,
      },
    });
    const applySpy = vi.spyOn(API, "applyAssetsToProject").mockResolvedValue({
      succeeded: [{ id: "scene-street", name: "street" }],
      skipped: [],
      failed: [],
    });

    render(
      <GenerateButton
        onClick={onClick}
        label="生成视频"
        preflight={{
          projectName: "demo",
          taskType: "video",
          resourceId: "E1S01",
          payload: { duration_seconds: 8 },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /生成视频/ }));
    await user.click(await screen.findByRole("button", { name: "一键应用场景素材" }));

    expect(addAssetSpy).toHaveBeenCalledWith({
      project_name: "demo",
      file_path: "travel_references/street.png",
      asset_type: "scene",
      name: "street",
      description: "旅游路线参考图：travel_references/street.png",
      conflict_policy: "rename",
    });
    expect(applySpy).toHaveBeenCalledWith({
      asset_ids: ["scene-street"],
      target_project: "demo",
      conflict_policy: "skip",
    });
    expect(preflightSpy).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("已修复，可以继续提交。")).toBeInTheDocument();
    expect(await screen.findByText("旅游参考图已全部应用为项目场景素材：1/1。")).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });
});
