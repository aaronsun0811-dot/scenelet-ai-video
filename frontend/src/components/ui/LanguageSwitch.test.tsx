import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { LanguageSwitch } from "./LanguageSwitch";

describe("LanguageSwitch", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh");
  });

  it("offers Japanese and switches to it", async () => {
    await i18n.changeLanguage("zh");

    render(<LanguageSwitch showLabel />);

    const select = screen.getByRole("combobox", { name: "语言" });
    expect(select).toHaveValue("zh");
    expect(screen.getByRole("option", { name: "JA" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "ja" } });

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "言語" })).toHaveValue("ja");
    });
  });
});
