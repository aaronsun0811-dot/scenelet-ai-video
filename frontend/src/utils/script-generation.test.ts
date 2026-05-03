import { describe, expect, it } from "vitest";
import type { EpisodeScript } from "@/types";
import { getScriptByFileKey, getScriptGenerationItems, resolveSegmentPrompt } from "./script-generation";

function makeScript(): EpisodeScript {
  return {
    episode: 1,
    title: "EP1",
    content_mode: "narration",
    duration_seconds: 4,
    summary: "summary",
    novel: { title: "Demo", chapter: "1" },
    segments: [
      {
        segment_id: "SEG-1",
        episode: 1,
        duration_seconds: 4,
        segment_break: false,
        novel_text: "text",
        characters_in_segment: [],
        image_prompt: "image prompt",
        video_prompt: "video prompt",
        transition_to_next: "cut",
      },
    ],
  };
}

describe("script generation helpers", () => {
  it("finds scripts with or without the scripts/ prefix", () => {
    const script = makeScript();
    expect(getScriptByFileKey({ "scripts/episode_1.json": script }, "episode_1.json")).toBe(script);
    expect(getScriptByFileKey({ "episode_1.json": script }, "scripts/episode_1.json")).toBe(script);
  });

  it("resolves prompts while preserving the normalized script file key for generation APIs", () => {
    const resolved = resolveSegmentPrompt(
      { "scripts/episode_1.json": makeScript() },
      "SEG-1",
      "image_prompt",
      "episode_1.json",
    );

    expect(resolved).toEqual({
      resolvedFile: "episode_1.json",
      prompt: "image prompt",
      duration: 4,
    });
  });

  it("reads reference-video units as generation items", () => {
    const script: EpisodeScript = {
      episode: 1,
      title: "EP1",
      content_mode: "reference_video",
      duration_seconds: 4,
      summary: "summary",
      novel: { title: "Demo", chapter: "1" },
      video_units: [
        {
          unit_id: "E1U01",
          shots: [{ duration: 4, text: "walk from station to market" }],
          references: [],
          duration_seconds: 4,
          duration_override: false,
          transition_to_next: "cut",
          note: null,
          generated_assets: {
            storyboard_image: null,
            storyboard_last_image: null,
            grid_id: null,
            grid_cell_index: null,
            video_clip: "reference_videos/E1U01.mp4",
            video_uri: "qa-fake://E1U01.mp4",
            status: "completed",
          },
        },
      ],
    };

    expect(getScriptGenerationItems(script)).toEqual([
      {
        id: "E1U01",
        imagePrompt: "",
        videoPrompt: "walk from station to market",
        duration: 4,
        hasStoryboard: false,
        hasVideo: true,
      },
    ]);
  });
});
