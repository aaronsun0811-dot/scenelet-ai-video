import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { SceneCard } from "./SceneCard";

vi.mock("@/components/canvas/timeline/VersionTimeMachine", () => ({
  VersionTimeMachine: () => <div data-testid="version-time-machine">versions</div>,
}));

describe("SceneCard", () => {
  const scene = { description: "阴森古朴" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders name and description", () => {
    render(
      <SceneCard
        name="庙宇"
        scene={scene}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByText("庙宇")).toBeInTheDocument();
    expect(screen.getByDisplayValue("阴森古朴")).toBeInTheDocument();
  });

  it("shows a travel reference source badge", () => {
    render(
      <SceneCard
        name="大阪街景"
        scene={{
          description: "难波街区",
          asset_source: {
            kind: "asset_library",
            source_kind: "travel_reference",
            source_file: "travel_references/osaka-map.png",
          },
        }}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByText("旅游参考图")).toBeInTheDocument();
  });

  it("invokes onGenerate after generation preflight confirmation", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    vi.spyOn(API, "requestGenerationPreflight").mockResolvedValue({
      project_name: "demo",
      task_type: "scene",
      resource_id: "A",
      billing_mode: "byok",
      required_credits: 0,
      count: 1,
      minimum_generation_balance: 1,
      can_submit: true,
      blocking: [],
      warnings: [{ code: "byok_uses_user_api", message: "本次生成将使用用户自己的 API Key，不扣平台积分。" }],
    });
    render(
      <SceneCard
        name="A"
        scene={scene}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={onGenerate}
      />,
    );
    await user.click(screen.getByRole("button", { name: /生成/ }));
    await user.click(await screen.findByRole("button", { name: "确认提交" }));

    expect(onGenerate).toHaveBeenCalledWith("A");
  });

  it("shows save button only when dirty", () => {
    render(
      <SceneCard
        name="A"
        scene={scene}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /保存/ })).not.toBeInTheDocument();

    const textarea = screen.getByDisplayValue("阴森古朴");
    fireEvent.change(textarea, { target: { value: "新描述" } });
    expect(screen.getByRole("button", { name: /保存/ })).toBeInTheDocument();
  });

  it("calls onUpdate when save button clicked", () => {
    const onUpdate = vi.fn();
    render(
      <SceneCard
        name="A"
        scene={scene}
        projectName="demo"
        onUpdate={onUpdate}
        onGenerate={vi.fn()}
      />,
    );

    const textarea = screen.getByDisplayValue("阴森古朴");
    fireEvent.change(textarea, { target: { value: "新描述" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(onUpdate).toHaveBeenCalledWith("A", { description: "新描述" });
  });

  it("renders VersionTimeMachine", () => {
    render(
      <SceneCard
        name="A"
        scene={scene}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("version-time-machine")).toBeInTheDocument();
  });

  it("does not render importance or type badges", () => {
    render(
      <SceneCard
        name="A"
        scene={scene}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByText(/major|minor|主要|次要|location|场景类型/i)).toBeNull();
  });

  it("always shows generate button (not gated on importance)", () => {
    render(
      <SceneCard
        name="A"
        scene={{ description: "" }}
        projectName="demo"
        onUpdate={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /生成/ })).toBeInTheDocument();
  });
});
