import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import "@/i18n";
import { API } from "@/api";
import { useProjectsStore } from "@/stores/projects-store";
import { CharactersPage } from "./CharactersPage";

describe("CharactersPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
  });

  function mockPreflight(taskType: "character" = "character") {
    return vi.spyOn(API, "requestGenerationPreflight").mockResolvedValue({
      project_name: "demo",
      task_type: taskType,
      billing_mode: "byok",
      required_credits: 0,
      count: 1,
      minimum_generation_balance: 1,
      can_submit: true,
      blocking: [],
      warnings: [],
    });
  }

  it("escapes the nested workspace route when opening character style settings", () => {
    useProjectsStore.setState({
      currentProjectData: {
        title: "Demo",
        content_mode: "drama",
        style: "",
        character_style_prompt: "真人短剧质感",
        episodes: [],
        characters: {},
      },
    });
    const location = memoryLocation({ path: "/characters", record: true });

    render(
      <Router hook={location.hook}>
        <CharactersPage
          projectName="demo project"
          characters={{}}
          onSaveCharacter={vi.fn()}
          onGenerateCharacter={vi.fn()}
          onAddCharacter={vi.fn()}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /设置人物风格|Set Character Style/ }));

    expect(location.history?.at(-1)).toBe("/app/projects/demo%20project/settings");
  });

  it("shows a batch action for missing character designs", async () => {
    const onGenerateMissingCharacters = vi.fn();
    mockPreflight();
    const location = memoryLocation({ path: "/characters", record: true });

    render(
      <Router hook={location.hook}>
        <CharactersPage
          projectName="demo"
          characters={{
            Hero: { description: "hero" },
            Mentor: { description: "mentor", character_sheet: "characters/Mentor.png" },
          }}
          onSaveCharacter={vi.fn()}
          onGenerateCharacter={vi.fn()}
          onGenerateMissingCharacters={onGenerateMissingCharacters}
          onAddCharacter={vi.fn()}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /生成缺失人物 1|Generate Missing 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));

    expect(onGenerateMissingCharacters).toHaveBeenCalledTimes(1);
  });

  it("can generate the character list from project material", async () => {
    const onGenerateCharacters = vi.fn();
    mockPreflight();
    const location = memoryLocation({ path: "/characters", record: true });

    render(
      <Router hook={location.hook}>
        <CharactersPage
          projectName="demo"
          characters={{}}
          onSaveCharacter={vi.fn()}
          onGenerateCharacter={vi.fn()}
          onGenerateCharacters={onGenerateCharacters}
          onAddCharacter={vi.fn()}
        />
      </Router>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^(生成角色|Generate Characters)$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));

    expect(onGenerateCharacters).toHaveBeenCalledTimes(1);
  });
});
