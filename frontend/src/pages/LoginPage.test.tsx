import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { LoginPage } from "@/pages/LoginPage";
import { useAuthStore } from "@/stores/auth-store";

function renderPage() {
  const location = memoryLocation({ path: "/login", record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <LoginPage />
      </Router>,
    ),
    location,
  };
}

describe("LoginPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("shows the registration channel by default", async () => {
    vi.spyOn(API, "getAuthCapabilities").mockRejectedValue(new Error("offline"));

    renderPage();

    expect(screen.getByRole("button", { name: "创建账号" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(screen.getByText("确认密码")).toBeInTheDocument();
  });

  it("hides the registration channel when the server explicitly disables it", async () => {
    vi.spyOn(API, "getAuthCapabilities").mockResolvedValue({
      db_users_enabled: true,
      registration_enabled: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "创建账号" })).not.toBeInTheDocument();
    });
  });
});
