import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { CharactersPage } from "./CharactersPage";
import { ScenesPage } from "./ScenesPage";
import { PropsPage } from "./PropsPage";
import { useAppStore } from "@/stores/app-store";

vi.mock("./CharacterCard", () => ({
  CharacterCard: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("./SceneCard", () => ({
  SceneCard: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("./PropCard", () => ({
  PropCard: ({ name }: { name: string }) => <div>{name}</div>,
}));

function renderWithRouter(children: React.ReactNode, path: string) {
  const location = memoryLocation({ path, record: true });
  return render(
    <Router hook={location.hook}>
      {children}
    </Router>,
  );
}

describe("Lorebook scroll targets", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    scrollIntoView = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  it("mounts locatable anchors for character cards", async () => {
    renderWithRouter(
      <CharactersPage
        projectName="demo"
        characters={{ Hero: { description: "hero" } }}
        onSaveCharacter={vi.fn()}
        onGenerateCharacter={vi.fn()}
        onAddCharacter={vi.fn()}
      />,
      "/characters",
    );

    act(() => {
      useAppStore.getState().triggerScrollTo({ type: "character", id: "Hero", route: "/characters" });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.getElementById("character-Hero")).toBeTruthy();
  });

  it("mounts locatable anchors for scene and prop cards", async () => {
    renderWithRouter(
      <>
        <ScenesPage
          projectName="demo"
          scenes={{ Market: { description: "market" } }}
          onUpdateScene={vi.fn()}
          onGenerateScene={vi.fn()}
          onAddScene={vi.fn()}
        />
        <PropsPage
          projectName="demo"
          props={{ Ring: { description: "ring" } }}
          onUpdateProp={vi.fn()}
          onGenerateProp={vi.fn()}
          onAddProp={vi.fn()}
        />
      </>,
      "/scenes",
    );

    act(() => {
      useAppStore.getState().triggerScrollTo({ type: "scene", id: "Market", route: "/scenes" });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.getElementById("scene-Market")).toBeTruthy();
    expect(document.getElementById("prop-Ring")).toBeTruthy();
  });
});
