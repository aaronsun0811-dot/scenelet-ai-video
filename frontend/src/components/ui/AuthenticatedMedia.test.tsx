import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { AuthenticatedVideo } from "@/components/ui/AuthenticatedMedia";

describe("AuthenticatedVideo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses a path-bound file token instead of fetching project videos into a blob", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(API, "requestFileAccessToken").mockResolvedValue({
      expires_in: 300,
      file_token: "short-file-token",
    });

    render(
      <AuthenticatedVideo
        controls
        data-testid="preview-video"
        src="/api/v1/files/demo/videos/scene.mp4?v=7"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-video").getAttribute("src")).toBe(
        "/api/v1/files/demo/videos/scene.mp4?v=7&file_token=short-file-token",
      );
    });
    expect(API.requestFileAccessToken).toHaveBeenCalledWith("demo", "videos/scene.mp4");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
