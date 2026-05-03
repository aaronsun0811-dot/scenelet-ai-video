import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import "@/i18n";
import { ProviderModelSelect } from "./ProviderModelSelect";

const OPTIONS = ["gemini-aistudio/veo-3.1-generate-001", "ark/seedance"];
const PROVIDER_NAMES = { "gemini-aistudio": "Gemini AI Studio", ark: "Ark" };

describe("ProviderModelSelect – trigger display", () => {
  it("shows placeholder when value is empty and no fallback provided", () => {
    render(
      <ProviderModelSelect
        value=""
        options={OPTIONS}
        providerNames={PROVIDER_NAMES}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent(/选择模型/);
  });

  it("shows selected provider · model when value is non-empty", () => {
    render(
      <ProviderModelSelect
        value="ark/seedance"
        options={OPTIONS}
        providerNames={PROVIDER_NAMES}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent(/Ark/);
    expect(trigger).toHaveTextContent(/seedance/);
  });

  it("shows 'follow global default · provider · model' when value is empty and fallbackValue provided", () => {
    render(
      <ProviderModelSelect
        value=""
        options={OPTIONS}
        providerNames={PROVIDER_NAMES}
        onChange={() => {}}
        allowDefault
        fallbackValue="gemini-aistudio/veo-3.1-generate-001"
      />,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent(/跟随全局默认/);
    expect(trigger).toHaveTextContent(/Gemini AI Studio/);
    expect(trigger).toHaveTextContent(/veo-3\.1-generate-001/);
  });

  it("prefers value over fallbackValue when both are provided", () => {
    render(
      <ProviderModelSelect
        value="ark/seedance"
        options={OPTIONS}
        providerNames={PROVIDER_NAMES}
        onChange={() => {}}
        allowDefault
        fallbackValue="gemini-aistudio/veo-3.1-generate-001"
      />,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger).not.toHaveTextContent(/跟随全局默认/);
    expect(trigger).toHaveTextContent(/Ark/);
    expect(trigger).toHaveTextContent(/seedance/);
  });

  it("renders the options layer outside clipped parents and keeps options clickable", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <div style={{ overflow: "hidden", height: 44 }}>
        <ProviderModelSelect
          value=""
          options={OPTIONS}
          providerNames={PROVIDER_NAMES}
          onChange={onChange}
          allowDefault
        />
      </div>,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await user.click(screen.getByRole("option", { name: "seedance" }));

    expect(onChange).toHaveBeenCalledWith("ark/seedance");
  });

  it("uses full option labels for global rule targets", async () => {
    const user = userEvent.setup();
    render(
      <ProviderModelSelect
        value="__media__/image"
        options={["__media__/image", "__media__/video"]}
        providerNames={{ "__media__": "生成类型" }}
        optionLabels={{
          "__media__/image": "生成图片（全局）",
          "__media__/video": "生成视频（全局）",
        }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("生成图片（全局）");

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: /生成视频（全局）/ })).toBeInTheDocument();
  });
});
