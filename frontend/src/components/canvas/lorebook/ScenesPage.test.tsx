import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScenesPage } from "./ScenesPage";

vi.mock("./SceneCard", () => ({
  SceneCard: ({ name }: { name: string }) => (
    <div data-testid={`scene-card-${name}`}>{name}</div>
  ),
}));

describe("ScenesPage", () => {
  const baseProps = {
    projectName: "demo",
    onUpdateScene: vi.fn(),
    onGenerateScene: vi.fn(),
    onAddScene: vi.fn(),
  };

  it("filters scene cards by asset source", () => {
    render(
      <ScenesPage
        {...baseProps}
        scenes={{
          "大阪街景": {
            description: "难波街区",
            asset_source: {
              kind: "asset_library",
              source_kind: "travel_reference",
              source_file: "travel_references/osaka-map.png",
            },
          },
          "通用街道": {
            description: "可复用街道",
            asset_source: {
              kind: "asset_library",
              source_kind: "asset_library",
            },
          },
          "手动场景": {
            description: "手动录入",
          },
        }}
      />,
    );

    expect(screen.getByTestId("scene-card-大阪街景")).toBeInTheDocument();
    expect(screen.getByTestId("scene-card-通用街道")).toBeInTheDocument();
    expect(screen.getByTestId("scene-card-手动场景")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^旅游参考图\s*1$/ }));

    expect(screen.getByTestId("scene-card-大阪街景")).toBeInTheDocument();
    expect(screen.queryByTestId("scene-card-通用街道")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scene-card-手动场景")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^资产库\s*1$/ }));

    expect(screen.queryByTestId("scene-card-大阪街景")).not.toBeInTheDocument();
    expect(screen.getByTestId("scene-card-通用街道")).toBeInTheDocument();
    expect(screen.queryByTestId("scene-card-手动场景")).not.toBeInTheDocument();
  });
});
