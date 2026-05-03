import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@/i18n"; // ensure i18n resources loaded
import { WizardStep1Basics } from "./WizardStep1Basics";

const baseValue = {
  title: "",
  contentType: "scene_sketch" as const,
  billingMode: "byok" as const,
  contentMode: "drama" as const,
  aspectRatio: "16:9" as const,
  generationMode: "storyboard" as const,
};

describe("WizardStep1Basics", () => {
  it("disables Next button when title is empty", () => {
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={() => {}}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /下一步/ })).toBeDisabled();
  });

  it("enables Next button when title has content", () => {
    render(
      <WizardStep1Basics
        value={{ ...baseValue, title: "demo" }}
        onChange={() => {}}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled();
  });

  it("calls onNext when Next is clicked with valid title", () => {
    const onNext = vi.fn();
    render(
      <WizardStep1Basics
        value={{ ...baseValue, title: "demo" }}
        onChange={() => {}}
        onNext={onNext}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("does not expose the immutable content mode as a separate create-time override", () => {
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={() => {}}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("radiogroup", { name: /内容模式|Content Mode/ })).not.toBeInTheDocument();
  });

  it("emits onChange when content type changes", () => {
    const onChange = vi.fn();
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/短剧|Short Drama/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "short_drama",
        contentMode: "drama",
        aspectRatio: "9:16",
        generationMode: "storyboard",
      }),
    );
  });

  it("emits travel video defaults while still allowing portrait override afterwards", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <WizardStep1Basics
        value={baseValue}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/旅游视频|Travel Video/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "travel_video",
        contentMode: "narration",
        aspectRatio: "16:9",
        generationMode: "reference_video",
      }),
    );

    onChange.mockClear();
    rerender(
      <WizardStep1Basics
        value={{ ...baseValue, contentType: "travel_video", contentMode: "narration", aspectRatio: "16:9", generationMode: "reference_video" }}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /竖屏 9:16|Portrait 9:16/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: "9:16" }));
  });

  it("emits onChange when billing mode changes", () => {
    const onChange = vi.fn();
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/平台积分|Platform Credits/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ billingMode: "platform_credits" }),
    );
  });

  it("emits onChange when aspect ratio changes", () => {
    const onChange = vi.fn();
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /竖屏 9:16|Portrait 9:16/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" }),
    );
  });

  it("emits onChange when generation mode changes", () => {
    const onChange = vi.fn();
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    // click 宫格生视频 / Grid-to-Video
    fireEvent.click(screen.getByText(/Grid-to-Video|宫格生视频/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ generationMode: "grid" }),
    );
  });

  it("emits onChange when title input changes", () => {
    const onChange = vi.fn();
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ title: "hello" }),
    );
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={() => {}}
        onNext={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /取消|Cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("marks title input as aria-required", () => {
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={() => {}}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-required", "true");
  });

  it("renders project_id_auto_gen_hint below the title input", () => {
    render(
      <WizardStep1Basics
        value={baseValue}
        onChange={() => {}}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.getByText(/系统会自动生成内部项目标识/),
    ).toBeInTheDocument();
  });

  it("switches generation mode to reference_video", () => {
    const onChange = vi.fn();
    render(
      <WizardStep1Basics
        value={{ title: "t", contentType: "scene_sketch", billingMode: "byok", contentMode: "narration", aspectRatio: "9:16", generationMode: "storyboard" }}
        onChange={onChange}
        onNext={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Reference-to-Video|参考生视频/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ generationMode: "reference_video" }));
  });
});
