import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { StylePicker, type StylePickerValue } from "@/components/shared/StylePicker";
import { setToken } from "@/utils/auth";

describe("StylePicker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads existing project file style previews with Authorization instead of a bare image request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["png"], { type: "image/png" })),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:style-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    setToken("jwt-token");

    const value: StylePickerValue = {
      mode: "custom",
      templateId: null,
      activeCategory: "content",
      uploadedFile: null,
      uploadedPreview: "/api/v1/files/demo/style_reference.png",
    };

    render(<StylePicker value={value} onChange={vi.fn()} />);

    const img = screen.getByAltText(/上传风格参考图|Upload style reference/) as HTMLImageElement;
    await waitFor(() => {
      expect(img.getAttribute("src")).toBe("blob:style-preview");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/files/demo/style_reference.png", {
      headers: { Authorization: "Bearer jwt-token" },
      signal: expect.any(AbortSignal),
    });
  });
});
