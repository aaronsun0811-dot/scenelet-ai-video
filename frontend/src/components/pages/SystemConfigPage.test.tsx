import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useProjectsStore } from "@/stores/projects-store";
import { SystemConfigPage } from "@/components/pages/SystemConfigPage";
import { getStripeSandboxAssist } from "@/utils/stripe-sandbox";
import type { GetSystemConfigResponse, GetSystemVersionResponse, ProviderInfo } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigResponse(
  overrides?: Partial<GetSystemConfigResponse["settings"]>,
): GetSystemConfigResponse {
  return {
    settings: {
      default_video_backend: "gemini/veo-3",
      default_image_backend: "gemini/imagen-4",
      default_text_backend: "",
      text_backend_script: "",
      text_backend_overview: "",
      text_backend_style: "",
      video_generate_audio: true,
      anthropic_api_key: { is_set: true, masked: "sk-ant-***" },
      google_maps_api_key: { is_set: false, masked: null },
      anthropic_base_url: "",
      anthropic_model: "",
      agent_model_backend: "",
      anthropic_default_haiku_model: "",
      anthropic_default_opus_model: "",
      anthropic_default_sonnet_model: "",
      claude_code_subagent_model: "",
      agent_session_cleanup_delay_seconds: 300,
      agent_max_concurrent_sessions: 5,
      about_title: "",
      about_subtitle: "",
      about_body: "",
      about_contact_label: "",
      about_contact_url: "",
      model_rule_configs: {},
      ...overrides,
    },
    options: {
      video_backends: ["gemini/veo-3"],
      image_backends: ["gemini/imagen-4"],
      text_backends: [],
      agent_backends: ["anthropic/claude-sonnet-4-5-20250929"],
    },
  };
}

function makeProviders(overrides?: Partial<ProviderInfo>): { providers: ProviderInfo[] } {
  return {
    providers: [
      {
        id: "gemini",
        display_name: "Google Gemini",
        description: "Google Gemini API",
        status: "ready",
        media_types: ["image", "video", "text"],
        capabilities: [],
        configured_keys: ["api_key"],
        missing_keys: [],
        models: {},
        ...overrides,
      },
    ],
  };
}

function makeVersionResponse(overrides?: Partial<GetSystemVersionResponse>): GetSystemVersionResponse {
  return {
    current: { version: "0.9.0" },
    latest: {
      version: "0.9.1",
      tag_name: "v0.9.1",
      name: "0.9.1",
      body: "## What's Changed\n- add about tab",
      html_url: "https://github.com/example/Scenelet/releases/tag/v0.9.1",
      published_at: "2026-04-21T08:00:00Z",
    },
    has_update: true,
    checked_at: "2026-04-21T09:00:00Z",
    update_check_error: null,
    ...overrides,
  };
}

function renderPage(path = "/app/settings") {
  const location = memoryLocation({ path, record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <SystemConfigPage />
      </Router>,
    ),
    location,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SystemConfigPage", () => {
  beforeEach(() => {
    useConfigStatusStore.setState(useConfigStatusStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    vi.restoreAllMocks();
    window.localStorage.clear();

    // Default: silence child section network calls so tests don't hang
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(makeConfigResponse());
    vi.spyOn(API, "verifyAuth").mockResolvedValue({
      valid: true,
      username: "admin",
      user_id: "default",
      role: "admin",
    });
    vi.spyOn(API, "getProviders").mockResolvedValue(makeProviders());
    vi.spyOn(API, "listCustomProviders").mockResolvedValue({ providers: [] });
    vi.spyOn(API, "getSystemVersion").mockResolvedValue(makeVersionResponse());
    vi.spyOn(API, "getProviderConfig").mockResolvedValue({
      id: "gemini",
      display_name: "Google Gemini",
      status: "ready",
      media_types: ["image", "video"],
      capabilities: [],
      fields: [],
    } as never);
    vi.spyOn(API, "listCredentials").mockResolvedValue({ credentials: [] });
    vi.spyOn(API, "getUsageStatsGrouped").mockResolvedValue({ stats: [], period: { start: "", end: "" } });
    vi.spyOn(API, "getProjectNamespaceMigrationPreview").mockResolvedValue({
      dry_run: true,
      candidates: [],
      migrated: [],
      skipped: [],
      conflicts: [],
      errors: [],
    });
    vi.spyOn(API, "testMapProvider").mockResolvedValue({ success: true, provider: "google", message: "ok" });
    vi.spyOn(API, "listUsers").mockResolvedValue([
      {
        id: "user_alice",
        username: "alice",
        role: "user",
        is_active: true,
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);
    vi.spyOn(API, "updateUser").mockImplementation(async (userId, payload) => ({
      id: userId,
      username: "alice",
      role: payload.role ?? "user",
      is_active: payload.is_active ?? true,
      created_at: "2026-05-01T00:00:00Z",
    }));
    vi.spyOn(API, "createUser").mockResolvedValue({
      id: "user_bob",
      username: "bob",
      role: "user",
      is_active: true,
      created_at: "2026-05-01T01:00:00Z",
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 0, minimum_generation_balance: 1, pending_purchase_credits: 0, entries: [] });
    vi.spyOn(API, "getUserCreditBalance").mockResolvedValue({
      balance: 1000,
      minimum_generation_balance: 1,
      pending_purchase_credits: 0,
      entries: [],
    });
    vi.spyOn(API, "grantCredits").mockResolvedValue({
      id: 1,
      amount: 1000,
      kind: "manual_grant",
      status: "posted",
      description: "内测手动入账",
    });
    vi.spyOn(API, "cancelCreditOrder").mockResolvedValue({
      id: 2,
      amount: 1000,
      kind: "purchase",
      status: "cancelled",
      reference_type: "credit_order",
      reference_id: "co_demo",
    });
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: false,
      missing: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      mode: "unknown",
      sandbox_tools_enabled: false,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
  });

  it("cancels a manual pending sandbox order", async () => {
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: false,
      missing: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      mode: "unknown",
      sandbox_tools_enabled: true,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 0,
      minimum_generation_balance: 1,
      pending_purchase_credits: 1000,
      entries: [
        {
          id: 2,
          amount: 1000,
          kind: "purchase",
          status: "pending",
          reference_type: "credit_order",
          reference_id: "co_manual",
          metadata: { payment_method: "manual" },
        },
      ],
    });
    const cancelSpy = vi.spyOn(API, "cancelCreditOrder").mockResolvedValue({
      id: 2,
      amount: 1000,
      kind: "purchase",
      status: "cancelled",
      reference_type: "credit_order",
      reference_id: "co_manual",
      metadata: { payment_method: "manual" },
    });

    renderPage("/app/settings?section=billing");

    expect(await screen.findByText("co_manual")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消订单" }));

    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith("co_manual");
    });
    expect(useAppStore.getState().toast?.text).toContain("订单已取消");
  });

  it("does not locally cancel Stripe checkout pending orders", async () => {
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 0,
      minimum_generation_balance: 1,
      pending_purchase_credits: 1000,
      entries: [
        {
          id: 3,
          amount: 1000,
          kind: "purchase",
          status: "pending",
          reference_type: "credit_order",
          reference_id: "co_stripe",
          metadata: {
            payment_method: "stripe",
            stripe_checkout_url: "https://checkout.stripe.com/c/pay/cs_test_demo",
          },
        },
      ],
    });

    renderPage("/app/settings?section=billing");

    expect(await screen.findByText("co_stripe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续支付" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消订单" })).not.toBeInTheDocument();
  });

  it("renders the page header", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("系统配置与 API 访问管理")).toBeInTheDocument();
  });

  it("renders all 10 sidebar sections", () => {
    renderPage();
    expect(screen.getByRole("button", { name: /智能体/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /供应商/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /模型选择/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /地图与旅游/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /用量统计/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /支付联调/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /用户/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /维护/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /API 令牌/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /关于/ })).toBeInTheDocument();
  });

  it("renders the user management section", async () => {
    renderPage("/app/settings?section=users");
    expect(await screen.findByText("用户管理")).toBeInTheDocument();
    expect(await screen.findByText("alice")).toBeInTheDocument();
  });

  it("updates user role and status from the user management section", async () => {
    const updateSpy = vi.spyOn(API, "updateUser");

    renderPage("/app/settings?section=users");

    const roleSelect = await screen.findByRole("combobox", { name: "角色 alice" });
    fireEvent.change(roleSelect, { target: { value: "admin" } });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("user_alice", { role: "admin" });
    });

    fireEvent.click(await screen.findByRole("button", { name: "停用 alice" }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("user_alice", { is_active: false });
    });
    expect(useAppStore.getState().toast?.text).toBe("用户已更新");
  });

  it("resets a user password from the user management section", async () => {
    const updateSpy = vi.spyOn(API, "updateUser");

    renderPage("/app/settings?section=users");

    fireEvent.change(await screen.findByLabelText("给 alice 输入新密码"), {
      target: { value: "newpass123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修改 alice 的密码" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("user_alice", { password: "newpass123" });
    });
    expect(useAppStore.getState().toast?.text).toBe("密码已修改");
  });

  it("checks and grants credits from the user management section", async () => {
    const balanceSpy = vi.spyOn(API, "getUserCreditBalance").mockResolvedValue({
      balance: 1250,
      available_balance: 1050,
      reserved_generation_credits: 200,
      minimum_generation_balance: 1,
      pending_purchase_credits: 300,
      entries: [],
    });
    const grantSpy = vi.spyOn(API, "grantCredits").mockResolvedValue({
      id: 9,
      amount: 2000,
      kind: "manual_grant",
      status: "posted",
      description: "manual",
    });

    renderPage("/app/settings?section=users");

    expect(await screen.findByText("未查询余额")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查询 alice 的积分" }));
    await waitFor(() => {
      expect(balanceSpy).toHaveBeenCalledWith("user_alice");
    });
    expect(await screen.findByText("可用 1,050")).toBeInTheDocument();
    expect(screen.getByText("冻结 200")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("给 alice 输入发放分数"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "给 alice 发放积分" }));
    await waitFor(() => {
      expect(grantSpy).toHaveBeenCalledWith({
        amount: 2000,
        user_id: "user_alice",
        description: "管理员给 alice 手动发放积分",
      });
    });
    expect(useAppStore.getState().toast?.text).toBe("积分已发放");
  });

  it("creates a user from the user management section", async () => {
    const createSpy = vi.spyOn(API, "createUser");

    renderPage("/app/settings?section=users");

    expect(await screen.findByRole("button", { name: "创建账号" })).toBeInTheDocument();
    expect(await screen.findByText("alice")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("初始密码"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith({
        username: "bob",
        password: "password123",
        role: "user",
      });
    });
    expect(await screen.findByText("bob")).toBeInTheDocument();
    expect(useAppStore.getState().toast?.text).toBe("账号已创建");
  });

  it("renders the maintenance namespace migration section", async () => {
    renderPage("/app/settings?section=maintenance");
    expect(await screen.findByText("项目命名空间迁移")).toBeInTheDocument();
    expect(screen.getByText("暂无需要迁移的旧用户项目。")).toBeInTheDocument();
  });

  it("saves and clears the optional Google Maps key", async () => {
    const updateSpy = vi.spyOn(API, "updateSystemConfig")
      .mockResolvedValueOnce(makeConfigResponse({
        google_maps_api_key: { is_set: true, masked: "AIza***demo" },
      }))
      .mockResolvedValueOnce(makeConfigResponse({
        google_maps_api_key: { is_set: false, masked: null },
      }));

    renderPage("/app/settings?section=maps");

    expect(await screen.findByText("Google 街景/地图")).toBeInTheDocument();
    expect(screen.getByText("Google 街景/地图未配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏地图与旅游设置" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Google Maps API Key"), { target: { value: " AIza-demo " } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Google Key" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({ google_maps_api_key: "AIza-demo" });
    });
    expect(await screen.findByText("AIza***demo")).toBeInTheDocument();
    expect(useAppStore.getState().toast?.text).toBe("Google 地图配置已保存");

    fireEvent.click(screen.getByRole("button", { name: "清除 Google Key" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({ google_maps_api_key: "" });
    });
    expect(useAppStore.getState().toast?.text).toBe("Google 地图配置已清除");
  });

  it("tests a draft domestic map key before saving", async () => {
    const testSpy = vi.spyOn(API, "testMapProvider").mockResolvedValue({
      success: true,
      provider: "baidu",
      message: "百度地图 Key 可用",
    });

    renderPage("/app/settings?section=maps");

    expect(await screen.findByText("百度地图")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("百度地图 AK"), { target: { value: " baidu-demo " } });
    fireEvent.click(screen.getAllByRole("button", { name: "测试连接" })[1]);

    await waitFor(() => {
      expect(testSpy).toHaveBeenCalledWith({ provider: "baidu", api_key: "baidu-demo" });
    });
    expect(useAppStore.getState().toast?.text).toBe("百度地图 Key 可用");
  });

  it("defaults to the 智能体 section", () => {
    renderPage();
    const agentButton = screen.getByRole("button", { name: /智能体/ });
    // Active sidebar item has the indigo border class applied
    expect(agentButton.className).toContain("border-indigo-500");
  });

  it("shows the agent model selector before API credentials and includes non-Claude models", async () => {
    renderPage();

    const selector = await screen.findByRole("combobox", { name: "智能体供应商 / 模型" });
    const apiHeading = screen.getByText("API 凭证");
    expect(selector.compareDocumentPosition(apiHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(selector);

    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(await screen.findByText("DeepSeek")).toBeInTheDocument();
  });

  it("clicking 供应商 makes it the active section", async () => {
    renderPage();
    const providersButton = screen.getByRole("button", { name: /供应商/ });
    fireEvent.click(providersButton);
    await waitFor(() => {
      expect(providersButton.className).toContain("border-indigo-500");
    });
  });

  it("clicking 模型选择 makes it the active section", async () => {
    renderPage();
    const mediaButton = screen.getByRole("button", { name: /模型选择/ });
    fireEvent.click(mediaButton);
    await waitFor(() => {
      expect(mediaButton.className).toContain("border-indigo-500");
    });
  });

  it("saves a single prompt rule for the image generation target", async () => {
    const updateSpy = vi.spyOn(API, "updateSystemConfig").mockResolvedValue(makeConfigResponse({
      model_rule_configs: {
        "__media__/image": {
          mode: "prompt",
          prompt: "使用旅游口播规则",
        },
      },
    }));

    renderPage("/app/settings?section=media");

    expect(await screen.findByText("模型规则")).toBeInTheDocument();
    const imageRuleGroup = (await screen.findAllByRole("radiogroup", {
      name: /生成图片（全局）.*生成规则来源/,
    }))[0];
    fireEvent.click(within(imageRuleGroup).getByLabelText("添加 Prompt"));
    fireEvent.change(screen.getAllByLabelText("Prompt 内容")[0], {
      target: { value: "使用旅游口播规则" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    });
    expect(updateSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      model_rule_configs: {
        "__media__/image": {
          mode: "prompt",
          prompt: "使用旅游口播规则",
        },
      },
    });
    expect(
      Object.keys(
        (updateSpy.mock.calls.at(-1)?.[0] as Record<string, any>).model_rule_configs["__media__/image"],
      ),
    ).not.toContain("skill_content");
  });

  it("can configure a separate video generation target rule", async () => {
    const updateSpy = vi.spyOn(API, "updateSystemConfig").mockResolvedValue(makeConfigResponse({
      model_rule_configs: {
        "__media__/video": {
          mode: "prompt",
          prompt: "视频统一使用导游分镜规则",
        },
      },
    }));

    renderPage("/app/settings?section=media");

    const videoRuleGroup = await screen.findByRole("radiogroup", {
      name: /生成视频（全局）.*生成规则来源/,
    });
    fireEvent.click(within(videoRuleGroup).getByLabelText("添加 Prompt"));
    fireEvent.change(screen.getAllByLabelText("Prompt 内容")[0], {
      target: { value: "视频统一使用导游分镜规则" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    });
    expect(updateSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      model_rule_configs: {
        "__media__/video": {
          mode: "prompt",
          prompt: "视频统一使用导游分镜规则",
        },
      },
    });
  });

  it("deep-links directly to a requested model rule target", async () => {
    renderPage("/app/settings?section=media&ruleTarget=__media__%2Fvideo");

    const rulePicker = await screen.findByRole("combobox", {
      name: "选择要配置规则的生成类型或模型",
    });
    expect(rulePicker).toHaveTextContent("生成视频（全局）");
    expect(
      await screen.findAllByRole("radiogroup", {
        name: /生成视频（全局） 的生成规则来源/,
      }),
    ).toHaveLength(2);
  });

  it("allows configuring model rules before choosing global default models", async () => {
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(makeConfigResponse({
      default_video_backend: "",
      default_image_backend: "",
      text_backend_script: "",
      text_backend_overview: "",
      text_backend_style: "",
    }));

    renderPage("/app/settings?section=media");

    expect(await screen.findByText("模型规则")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "选择要配置规则的生成类型或模型" })).toBeInTheDocument();
    expect((await screen.findAllByLabelText("添加 Prompt")).length).toBeGreaterThan(0);
    expect(screen.queryByText("请先选择一个视频、图片或文本模型，再配置该模型的生成规则。")).not.toBeInTheDocument();
  });

  it("clicking 用量统计 makes it the active section", async () => {
    renderPage();
    const usageButton = screen.getByRole("button", { name: /用量统计/ });
    fireEvent.click(usageButton);
    await waitFor(() => {
      expect(usageButton.className).toContain("border-indigo-500");
    });
  });

  it("shows config warning banner when there are config issues", async () => {
    // Simulate unconfigured anthropic key to trigger an issue
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(
      makeConfigResponse({ anthropic_api_key: { is_set: false, masked: null } }),
    );
    vi.spyOn(API, "getProviders").mockResolvedValue(makeProviders({ status: "ready" }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("当前配置存在以下问题，可能会影响部分功能：")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Scenelet 智能体 API Key/),
    ).toBeInTheDocument();
  });

  it("does not show warning banner when config is complete", async () => {
    renderPage();

    // Give time for config status to load
    await waitFor(() => {
      expect(API.getProviders).toHaveBeenCalled();
    });

    expect(screen.queryByText("当前配置存在以下问题，可能会影响部分功能：")).not.toBeInTheDocument();
  });

  it("renders the back link that navigates to projects", () => {
    renderPage();
    const link = screen.getByRole("link", { name: "返回" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/app/projects");
  });

  it("shows the shared project shortcuts in the settings sidebar", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "侧边栏创作项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏资产库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏导入 ZIP" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "侧边栏创建项目" }));
    expect(screen.getByText("新建影视项目")).toBeInTheDocument();
  });

  it("logs out from the settings header", () => {
    useAuthStore.setState({
      token: "token-demo",
      username: "admin",
      isAuthenticated: true,
      isLoading: false,
    });

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "登出" }));

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("edits and saves the about page content", async () => {
    const updateSpy = vi.spyOn(API, "updateSystemConfig").mockResolvedValue(
      makeConfigResponse({
        about_title: "Scenelet 平台",
        about_subtitle: "多人 SaaS 视频创作平台",
        about_body: "管理员维护的说明",
        about_contact_label: "联系我们",
        about_contact_url: "https://example.com/contact",
      }),
    );

    renderPage("/app/settings?section=about");

    expect(await screen.findByText("管理员编辑")).toBeInTheDocument();
    expect(screen.queryByText("Release Notes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /检查更新/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Scenelet 平台" } });
    fireEvent.change(screen.getByLabelText("副标题"), { target: { value: "多人 SaaS 视频创作平台" } });
    fireEvent.change(screen.getByLabelText("正文说明"), { target: { value: "管理员维护的说明" } });
    fireEvent.change(screen.getByLabelText("链接文字"), { target: { value: "联系我们" } });
    fireEvent.change(screen.getByLabelText("链接地址"), { target: { value: "https://example.com/contact" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({
        about_title: "Scenelet 平台",
        about_subtitle: "多人 SaaS 视频创作平台",
        about_body: "管理员维护的说明",
        about_contact_label: "联系我们",
        about_contact_url: "https://example.com/contact",
      });
    });
    expect(useAppStore.getState().toast?.text).toBe("关于页面已保存");
  });

  it("renders the about page as read-only for normal users", async () => {
    vi.spyOn(API, "verifyAuth").mockResolvedValue({
      valid: true,
      username: "alice",
      user_id: "user_alice",
      role: "user",
    });
    vi.spyOn(API, "getSystemConfig").mockResolvedValue(makeConfigResponse({
      about_title: "Scenelet 平台",
      about_subtitle: "普通用户可查看",
      about_body: "这是管理员维护的公开介绍。",
      about_contact_label: "联系我们",
      about_contact_url: "https://example.com/contact",
    }));

    renderPage("/app/settings?section=about");

    expect(await screen.findByText("关于")).toBeInTheDocument();
    expect(screen.getByText("这是管理员维护的公开介绍。")).toBeInTheDocument();
    expect(screen.getByText("联系我们")).toHaveAttribute("href", "https://example.com/contact");
    expect(screen.queryByText("管理员编辑")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("renders Stripe sandbox instructions and toggles local sandbox assist", async () => {
    renderPage("/app/settings?section=billing");

    expect(await screen.findByText("Stripe 沙盒联调")).toBeInTheDocument();
    expect(screen.getByText("0 积分")).toBeInTheDocument();
    expect(screen.getByText("stripe listen --forward-to http://127.0.0.1:1241/api/v1/billing/stripe/webhook")).toBeInTheDocument();
    expect(getStripeSandboxAssist()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "本地沙盒联调" }));

    expect(getStripeSandboxAssist()).toBe(true);
    expect(screen.getByText("已开启")).toBeInTheDocument();
  });

  it("confirms a pending sandbox order when sandbox tools are enabled", async () => {
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: false,
      missing: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      mode: "unknown",
      sandbox_tools_enabled: true,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 0,
      minimum_generation_balance: 1,
      pending_purchase_credits: 1000,
      entries: [
        {
          id: 1,
          amount: 1000,
          kind: "purchase",
          status: "pending",
          reference_type: "credit_order",
          reference_id: "co_demo",
        },
      ],
    });
    vi.spyOn(API, "sandboxConfirmCreditOrder").mockResolvedValue({
      id: 1,
      amount: 1000,
      kind: "purchase",
      status: "posted",
      reference_type: "credit_order",
      reference_id: "co_demo",
    });

    renderPage("/app/settings?section=billing");

    expect(await screen.findByText("co_demo")).toBeInTheDocument();
    expect(screen.getByText("待到账：1,000 积分")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模拟支付成功" }));

    await waitFor(() => {
      expect(API.sandboxConfirmCreditOrder).toHaveBeenCalledWith("co_demo");
    });
  });

  it("manually grants credits from the billing lab", async () => {
    const grantSpy = vi.spyOn(API, "grantCredits").mockResolvedValue({
      id: 7,
      amount: 2500,
      kind: "manual_grant",
      status: "posted",
      description: "beta topup",
    });

    renderPage("/app/settings?section=billing");

    expect(await screen.findByText("手动积分入账")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("积分数量"), { target: { value: "2500" } });
    fireEvent.change(screen.getByLabelText("入账说明"), { target: { value: "beta topup" } });
    fireEvent.click(screen.getByRole("button", { name: "手动入账" }));

    await waitFor(() => {
      expect(grantSpy).toHaveBeenCalledWith({
        amount: 2500,
        description: "beta topup",
      });
    });
    expect(useAppStore.getState().toast?.text).toContain("积分已手动入账");
  });

  it("does not call version APIs from the editable about section", async () => {
    const versionSpy = vi.spyOn(API, "getSystemVersion");
    renderPage("/app/settings?section=about");

    expect(await screen.findByText("关于页面")).toBeInTheDocument();
    expect(versionSpy).not.toHaveBeenCalled();
  });
});
