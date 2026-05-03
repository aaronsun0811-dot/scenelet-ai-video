import { describe, expect, it } from "vitest";
import { makeTask } from "@/test/factories";
import { getActiveGenerationResourceIds } from "./generation-tasks";

describe("generation task helpers", () => {
  it("collects active task resource ids scoped by project, type, and script file", () => {
    const activeIds = getActiveGenerationResourceIds(
      [
        makeTask({
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-1",
          script_file: "scripts/episode_1.json",
          status: "queued",
        }),
        makeTask({
          task_id: "running",
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-2",
          script_file: "episode_1.json",
          status: "running",
        }),
        makeTask({
          task_id: "done",
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-3",
          script_file: "episode_1.json",
          status: "succeeded",
        }),
        makeTask({
          task_id: "other-script",
          project_name: "demo",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-4",
          script_file: "episode_2.json",
          status: "queued",
        }),
        makeTask({
          task_id: "other-project",
          project_name: "other",
          task_type: "storyboard",
          media_type: "image",
          resource_id: "SEG-5",
          script_file: "episode_1.json",
          status: "queued",
        }),
      ],
      "demo",
      "storyboard",
      "episode_1.json",
    );

    expect([...activeIds].sort()).toEqual(["SEG-1", "SEG-2"]);
  });
});
