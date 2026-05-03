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

  it("translates visible Japanese project and copilot empty states", async () => {
    await i18n.changeLanguage("ja");

    expect(i18n.t("dashboard:no_characters_hint_clickable")).toBe("人物はまだありません。クリックして追加");
    expect(i18n.t("dashboard:no_scenes_hint_clickable")).toBe("シーンはまだありません。クリックして追加");
    expect(i18n.t("dashboard:no_props_hint_clickable")).toBe("小道具はまだありません。クリックして追加");
    expect(i18n.t("dashboard:loading_project_data")).toBe("プロジェクトデータを読み込み中...");
    expect(i18n.t("dashboard:new_session")).toBe("新規セッション");
    expect(i18n.t("dashboard:start_chat_hint")).toBe("下の入力欄からメッセージを送信できます");
    expect(i18n.t("dashboard:quick_skill_hint")).toBe("/ を入力すると Skill をすばやく呼び出せます");
  });
});
