import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { ProjectsPage } from "@/components/pages/ProjectsPage";
import { setStripeSandboxAssist } from "@/utils/stripe-sandbox";

vi.mock("@/components/pages/CreateProjectModal", () => ({
  CreateProjectModal: () => <div data-testid="create-project-modal">Create Project Modal</div>,
}));

function renderPage() {
  const location = memoryLocation({ path: "/app/projects", record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <ProjectsPage />
      </Router>,
    ),
    location,
  };
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/app/projects");
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 0, minimum_generation_balance: 1, pending_purchase_credits: 0, entries: [] });
    vi.spyOn(API, "getCreditOrder").mockResolvedValue({
      id: 1,
      amount: 1000,
      kind: "purchase",
      status: "pending",
      reference_type: "credit_order",
      reference_id: "co_demo",
    });
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: true,
      missing: [],
      mode: "test",
      sandbox_tools_enabled: false,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
    vi.spyOn(API, "getProviders").mockResolvedValue({
      providers: [
        {
          id: "gemini",
          display_name: "Gemini",
          description: "",
          status: "ready",
          media_types: ["image", "video", "text"],
          capabilities: [],
          configured_keys: ["api_key"],
          missing_keys: [],
          models: {},
        },
      ],
    });
    vi.spyOn(API, "listCustomProviders").mockResolvedValue({ providers: [] });
    vi.spyOn(API, "getSystemConfig").mockResolvedValue({
      settings: {
        default_video_backend: "",
        default_image_backend: "",
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
      },
      options: {
        video_backends: [],
        image_backends: [],
        text_backends: [],
        agent_backends: [],
      },
    });
  });

  it("shows loading state while projects are being fetched", () => {
    vi.spyOn(API, "listProjects").mockImplementation(
      () => new Promise(() => {}),
    );

    renderPage();
    expect(screen.getByText("加载项目列表...")).toBeInTheDocument();
  });

  it("shows empty state when no projects exist", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();

    expect(await screen.findByText("暂无项目")).toBeInTheDocument();
    expect(
      screen.getByText("点击右上角「新建项目」或「导入 ZIP」开始创作"),
    ).toBeInTheDocument();
  });

  it("opens the Hermes Agent integration guide", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();

    expect(await screen.findByText("暂无项目")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hermes Agent 集成指南" }));

    expect(await screen.findByText("Hermes Agent 集成指南")).toBeInTheDocument();
    expect(screen.getByText("将 Scenelet 接入 Hermes Agent")).toBeInTheDocument();
    expect(screen.getByText(/学习 http:\/\/localhost:3000\/skill\.md/)).toBeInTheDocument();
  });

  it("shows project quick actions in the left sidebar", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();

    expect(await screen.findByText("暂无项目")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "顶部创作项目" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "顶部资产库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏创作项目" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "侧边栏资产库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏导入 ZIP" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏智能体设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏 API 令牌设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "侧边栏语言" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "侧边栏创建项目" }));
    expect(screen.getByTestId("create-project-modal")).toBeInTheDocument();
  });

  it("renders the current credit balance", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 1200, minimum_generation_balance: 1, pending_purchase_credits: 0, entries: [] });

    renderPage();

    expect(await screen.findByText("积分余额：1200")).toBeInTheDocument();
    expect(screen.getByTitle("生成门槛：1 积分")).toBeInTheDocument();
  });

  it("shows low-balance guidance in the project list and buy credits modal", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 0,
      minimum_generation_balance: 10,
      pending_purchase_credits: 0,
      entries: [],
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({ packages: [] });

    renderPage();

    expect(await screen.findByText(/积分余额：0/)).toBeInTheDocument();
    expect(screen.getByText("余额不足")).toBeInTheDocument();
    expect(screen.getByTitle("积分余额不足，生成至少需要 10 积分")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("积分余额不足，生成至少需要 10 积分")).toBeInTheDocument();
  });

  it("shows a visible Stripe success return notice and can refresh credits", async () => {
    window.history.replaceState(null, "", "/app/projects?checkout=success&order_id=co_demo");
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    const balanceSpy = vi.spyOn(API, "getCreditBalance").mockResolvedValue({ balance: 1200, minimum_generation_balance: 1, pending_purchase_credits: 0, entries: [] });
    const orderSpy = vi.spyOn(API, "getCreditOrder").mockResolvedValue({
      id: 1,
      amount: 1000,
      kind: "purchase",
      status: "posted",
      reference_type: "credit_order",
      reference_id: "co_demo",
    });

    renderPage();

    expect(await screen.findByText("支付已返回")).toBeInTheDocument();
    expect(screen.getByText("订单号：co_demo")).toBeInTheDocument();
    expect(await screen.findByText("订单状态：已入账")).toBeInTheDocument();
    await waitFor(() => {
      expect(balanceSpy).toHaveBeenCalledTimes(2);
    });
    expect(orderSpy).toHaveBeenCalledWith("co_demo");
    expect(window.location.search).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "刷新积分" }));

    await waitFor(() => {
      expect(balanceSpy).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(orderSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("shows a visible Stripe cancel return notice", async () => {
    window.history.replaceState(null, "", "/app/projects?checkout=cancel&order_id=co_demo");
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();

    expect(await screen.findByText("支付已取消")).toBeInTheDocument();
    expect(screen.getByText("订单号：co_demo")).toBeInTheDocument();
    expect(await screen.findByText("订单状态：待支付")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("renders recent credit ledger entries in the buy credits modal", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getCreditBalance").mockResolvedValue({
      balance: 933,
      available_balance: 853,
      minimum_generation_balance: 1,
      pending_purchase_credits: 1000,
      reserved_generation_credits: 80,
      entries: [
        {
          id: 4,
          amount: -67,
          kind: "generation_reservation",
          status: "released",
          reference_type: "task",
          reference_id: "task-released",
          created_at: "2026-05-01T00:03:00",
        },
        {
          id: 3,
          amount: -80,
          kind: "generation_reservation",
          status: "pending",
          reference_type: "task",
          reference_id: "task-active",
          created_at: "2026-05-01T00:02:00",
        },
        {
          id: 2,
          amount: -67,
          kind: "generation_usage",
          status: "posted",
          reference_type: "api_call",
          reference_id: "api-call-2",
          created_at: "2026-05-01T00:00:00",
        },
        {
          id: 1,
          amount: 1000,
          kind: "purchase",
          status: "pending",
          reference_type: "credit_order",
          reference_id: "co_demo",
          created_at: "2026-05-01T00:00:00",
        },
      ],
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({ packages: [] });

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("最近积分流水")).toBeInTheDocument();
    expect(screen.getByText("853 积分")).toBeInTheDocument();
    expect(screen.getAllByText("待到账：1,000 积分")).toHaveLength(2);
    expect(screen.getAllByText("生成冻结：80 积分")).toHaveLength(2);
    expect(screen.getByText("生成扣费")).toBeInTheDocument();
    expect(screen.getByText("-67")).toBeInTheDocument();
    expect(screen.getByText("生成冻结")).toBeInTheDocument();
    expect(screen.getByText("冻结中")).toBeInTheDocument();
    expect(screen.getByText("-80")).toBeInTheDocument();
    expect(screen.queryByText("已释放")).not.toBeInTheDocument();
    expect(screen.queryByText("task-released")).not.toBeInTheDocument();
    expect(screen.getByText("积分购买")).toBeInTheDocument();
    expect(screen.getByText("待支付")).toBeInTheDocument();
    expect(screen.getByText("+1,000")).toBeInTheDocument();

    const createObjectURL = vi.fn(() => "blob:credit-ledger");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(globalThis.URL, "createObjectURL", {
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(globalThis.URL, "revokeObjectURL", {
      writable: true,
      value: revokeObjectURL,
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "导出流水" }));

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:credit-ledger");
  });

  it("shows pending credit orders from ledger entries", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
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
          reference_id: "co_pending",
          metadata: {
            stripe_checkout_url: "https://checkout.stripe.com/c/pay/cs_pending",
          },
        },
      ],
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({ packages: [] });

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("待支付订单")).toBeInTheDocument();
    expect(screen.getByText("这些订单暂未入账，支付或沙盒确认后才会增加可用积分。")).toBeInTheDocument();
    expect(screen.getAllByText("co_pending")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "继续支付" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消订单" })).not.toBeInTheDocument();
  });

  it("cancels a manual pending credit order from the buy credits modal", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
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
          reference_id: "co_manual",
          metadata: {
            payment_method: "manual",
          },
        },
      ],
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({ packages: [] });
    vi.spyOn(API, "cancelCreditOrder").mockResolvedValue({
      id: 1,
      amount: 1000,
      kind: "purchase",
      status: "cancelled",
      reference_type: "credit_order",
      reference_id: "co_manual",
    });

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("待支付订单")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消订单" }));

    await waitFor(() => {
      expect(API.cancelCreditOrder).toHaveBeenCalledWith("co_manual");
    });
    expect(useAppStore.getState().toast?.text).toContain("订单已取消");
  });

  it("opens the buy credits modal from the buyCredits query parameter", async () => {
    window.history.replaceState(null, "", "/app/projects?buyCredits=1");
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({ packages: [] });

    renderPage();

    expect(await screen.findByText("当前积分余额")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("creates a pending credit order from the buy credits modal", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({
      packages: [
        {
          id: "starter",
          credits: 1000,
          currency: "CNY",
          price_minor: 990,
          description: "starter",
        },
      ],
    });
    vi.spyOn(API, "createCreditOrder").mockResolvedValue({
      order_id: "co_demo",
      status: "pending",
      package: {
        id: "starter",
        credits: 1000,
        currency: "CNY",
        price_minor: 990,
        description: "starter",
      },
      payment_method: "manual",
      payment_url: null,
      ledger_entry: {
        id: 1,
        amount: 1000,
        kind: "purchase",
        status: "pending",
      },
    });

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("1,000 积分")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建订单" }));

    await waitFor(() => {
      expect(API.createCreditOrder).toHaveBeenCalledWith({
        package_id: "starter",
        payment_method: "stripe",
      });
    });
    expect(await screen.findByText("订单已创建：co_demo")).toBeInTheDocument();
  });

  it("disables credit order creation when Stripe is not configured", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: false,
      missing: ["STRIPE_SECRET_KEY"],
      mode: "unknown",
      sandbox_tools_enabled: false,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({
      packages: [
        {
          id: "starter",
          credits: 1000,
          currency: "CNY",
          price_minor: 990,
          description: "starter",
        },
      ],
    });
    const createSpy = vi.spyOn(API, "createCreditOrder");

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("Stripe 尚未配置完整")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建订单" })).toBeDisabled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("uses manual pending orders when local sandbox assist is enabled", async () => {
    setStripeSandboxAssist(true);
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: false,
      missing: ["STRIPE_SECRET_KEY"],
      mode: "unknown",
      sandbox_tools_enabled: false,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({
      packages: [
        {
          id: "starter",
          credits: 1000,
          currency: "CNY",
          price_minor: 990,
          description: "starter",
        },
      ],
    });
    vi.spyOn(API, "createCreditOrder").mockResolvedValue({
      order_id: "co_local",
      status: "pending",
      package: {
        id: "starter",
        credits: 1000,
        currency: "CNY",
        price_minor: 990,
        description: "starter",
      },
      payment_method: "manual",
      payment_url: null,
      ledger_entry: {
        id: 1,
        amount: 1000,
        kind: "purchase",
        status: "pending",
      },
    });

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("本地沙盒联调已开启")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建订单" }));

    await waitFor(() => {
      expect(API.createCreditOrder).toHaveBeenCalledWith({
        package_id: "starter",
        payment_method: "manual",
      });
    });
  });

  it("can sandbox-confirm a local pending credit order from the buy credits modal", async () => {
    setStripeSandboxAssist(true);
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getStripeBillingStatus").mockResolvedValue({
      configured: false,
      missing: ["STRIPE_SECRET_KEY"],
      mode: "unknown",
      sandbox_tools_enabled: true,
      frontend_base_url: "http://localhost:5173",
      webhook_path: "/api/v1/billing/stripe/webhook",
    });
    vi.spyOn(API, "getCreditPackages").mockResolvedValue({
      packages: [
        {
          id: "starter",
          credits: 1000,
          currency: "CNY",
          price_minor: 990,
          description: "starter",
        },
      ],
    });
    vi.spyOn(API, "createCreditOrder").mockResolvedValue({
      order_id: "co_local",
      status: "pending",
      package: {
        id: "starter",
        credits: 1000,
        currency: "CNY",
        price_minor: 990,
        description: "starter",
      },
      payment_method: "manual",
      payment_url: null,
      ledger_entry: {
        id: 1,
        amount: 1000,
        kind: "purchase",
        status: "pending",
      },
    });
    vi.spyOn(API, "sandboxConfirmCreditOrder").mockResolvedValue({
      id: 1,
      amount: 1000,
      kind: "purchase",
      status: "posted",
      reference_type: "credit_order",
      reference_id: "co_local",
    });

    renderPage();
    await screen.findByText("暂无项目");
    fireEvent.click(screen.getByRole("button", { name: "购买积分" }));

    expect(await screen.findByText("1,000 积分")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建订单" }));

    expect(await screen.findByRole("button", { name: "模拟支付成功" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模拟支付成功" }));

    await waitFor(() => {
      expect(API.sandboxConfirmCreditOrder).toHaveBeenCalledWith("co_local");
    });
    expect(useAppStore.getState().toast?.text).toContain("沙盒订单已模拟入账");
  });

  it("renders project cards when data exists", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Demo Project",
          billing_mode: "platform_credits",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: {
            current_phase: "production",
            phase_progress: 0.5,
            characters: { total: 2, completed: 2 },
            scenes: { total: 1, completed: 1 },
            props: { total: 1, completed: 0 },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect(await screen.findByText("Demo Project")).toBeInTheDocument();
    expect(screen.getByText("商业动画 京都 · 制作中")).toBeInTheDocument();
    expect(screen.getByAltText("Demo Project")).toHaveAttribute("src", expect.stringContaining("/style-thumbnails/anim_kyoto.png"));
    expect(screen.getByText("平台积分")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("uses content-type cover art and route summary for travel video projects", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "osaka-walk",
          title: "Osaka Walk",
          content_type: "travel_video",
          billing_mode: "byok",
          style: "",
          style_template_id: null,
          thumbnail: null,
          travel_video_settings: {
            origin: "难波站",
            destination: "黑门市场",
            route_source: "manual",
            route_notes: "",
            narration_language: "zh",
            target_duration: "60s",
            camera_style: "street_walk_turns",
            narrator_persona: "enthusiastic_guide",
          },
          status: {
            current_phase: "setup",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect(await screen.findByText("Osaka Walk")).toBeInTheDocument();
    expect(screen.getByAltText("Osaka Walk")).toHaveAttribute("src", expect.stringContaining("/style-thumbnails/content_travel_video.png"));
    expect(screen.getByText("路线预览：难波站 → 黑门市场")).toBeInTheDocument();
    expect(screen.getByText("旅游视频 · 准备中")).toBeInTheDocument();
  });

  it("marks shared projects and hides owner-only delete actions", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "shared",
          title: "Shared Project",
          owner_user_id: "alice",
          current_user_role: "editor",
          billing_mode: "byok",
          style: "",
          style_template_id: null,
          thumbnail: null,
          status: {
            current_phase: "setup",
            phase_progress: 0.1,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect(await screen.findByText("Shared Project")).toBeInTheDocument();
    expect(screen.getByText("共享")).toBeInTheDocument();
    expect(screen.getByTitle("来自 alice 的共享项目")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
  });

  it("defaults missing project billing mode to user-provided API", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Legacy Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: {
            current_phase: "setup",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect(await screen.findByText("Legacy Project")).toBeInTheDocument();
    expect(screen.getByText("自己填 API")).toBeInTheDocument();
  });

  it("shows 自定义风格 label when project has style_image but no template_id", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Custom Demo",
          style: "",
          style_template_id: null,
          style_image: "style_reference.png",
          thumbnail: null,
          status: {
            current_phase: "production",
            phase_progress: 0.1,
            characters: { total: 1, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 1, scripted: 0, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    await screen.findByText("Custom Demo");
    expect(screen.getByText(/自定义风格/)).toBeInTheDocument();
  });

  it("shows 未设置风格 label when project has neither template_id nor style_image", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Empty Style Demo",
          style: "",
          style_template_id: null,
          style_image: null,
          thumbnail: null,
          status: {
            current_phase: "production",
            phase_progress: 0,
            characters: { total: 0, completed: 0 },
            scenes: { total: 0, completed: 0 },
            props: { total: 0, completed: 0 },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    await screen.findByText("Empty Style Demo");
    expect(screen.getByText(/未设置风格/)).toBeInTheDocument();
  });

  it("opens create project modal after clicking new project button", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();
    await screen.findByText("暂无项目");
    expect(screen.queryByTestId("create-project-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => {
      expect(screen.getByTestId("create-project-modal")).toBeInTheDocument();
    });
  });

  it("imports a zip project, refreshes the list, and navigates to the workspace", async () => {
    vi.spyOn(API, "listProjects")
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({
        projects: [
          {
            name: "imported-demo",
            title: "Imported Demo",
            style: "Anime",
            thumbnail: null,
            status: {
              current_phase: "completed",
              phase_progress: 1,
              characters: { total: 1, completed: 1 },
              scenes: { total: 1, completed: 1 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 1, scripted: 1, in_production: 0, completed: 1 },
            },
          },
        ],
      });
    vi.spyOn(API, "importProject").mockResolvedValue({
      success: true,
      project_name: "imported-demo",
      project: {
        title: "Imported Demo",
        content_mode: "narration",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
      warnings: ["发现未识别的附加文件/目录: extras"],
      conflict_resolution: "none",
      diagnostics: {
        auto_fixed: [{ code: "missing_clues_field", message: "segments[0]: 补全缺失字段 clues_in_segment" }],
        warnings: [{ code: "validation_warning", message: "发现未识别的附加文件/目录: extras" }],
      },
    });

    const { container, location } = renderPage();
    await screen.findByText("暂无项目");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["zip"], "project.zip", { type: "application/zip" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(API.importProject).toHaveBeenCalledWith(file, "prompt");
    });
    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/projects/imported-demo");
    });
    expect(useAppStore.getState().toast?.text).toContain("自动修复");
  });

  it("shows a structured toast when import fails", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    const error = new Error("导入包校验失败") as Error & {
      detail?: string;
      errors?: string[];
      warnings?: string[];
      diagnostics?: {
        blocking: { code: string; message: string }[];
        auto_fixable: { code: string; message: string }[];
        warnings: { code: string; message: string }[];
      };
    };
    error.detail = "导入包校验失败";
    error.errors = ["缺少 project.json", "缺少 scripts/episode_1.json", "缺少角色图"];
    error.warnings = ["发现未识别的附加文件/目录: extras"];
    error.diagnostics = {
      blocking: [
        { code: "validation_error", message: "缺少 project.json" },
        { code: "validation_error", message: "缺少 scripts/episode_1.json" },
      ],
      auto_fixable: [
        { code: "missing_clues_field", message: "segments[0]: 补全缺失字段 clues_in_segment" },
      ],
      warnings: [
        { code: "validation_warning", message: "发现未识别的附加文件/目录: extras" },
      ],
    };
    vi.spyOn(API, "importProject").mockRejectedValue(error);

    const { container } = renderPage();
    await screen.findByText("暂无项目");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["zip"], "broken.zip", { type: "application/zip" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("导出诊断")).toBeInTheDocument();
    });
    expect(screen.getByText("缺少 project.json")).toBeInTheDocument();
    expect(screen.getByText("缺少 scripts/episode_1.json")).toBeInTheDocument();
    expect(screen.getByText("segments[0]: 补全缺失字段 clues_in_segment")).toBeInTheDocument();
  });

  it("opens a secondary confirmation when import hits a duplicate project id", async () => {
    vi.spyOn(API, "listProjects")
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({
        projects: [
          {
            name: "demo",
            title: "Demo",
            style: "Anime",
            thumbnail: null,
            status: {
              current_phase: "completed",
              phase_progress: 1,
              characters: { total: 1, completed: 1 },
              scenes: { total: 1, completed: 1 },
              props: { total: 0, completed: 0 },
              episodes_summary: { total: 1, scripted: 1, in_production: 0, completed: 1 },
            },
          },
        ],
      });
    const conflictError = new Error("检测到项目编号冲突") as Error & {
      status?: number;
      detail?: string;
      errors?: string[];
      conflict_project_name?: string;
    };
    conflictError.status = 409;
    conflictError.detail = "检测到项目编号冲突";
    conflictError.errors = ["项目编号 'demo' 已存在"];
    conflictError.conflict_project_name = "demo";

    vi.spyOn(API, "importProject")
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({
        success: true,
        project_name: "demo-renamed",
        project: {
          title: "Renamed Demo",
          content_mode: "narration",
          style: "Anime",
          episodes: [],
          characters: {},
          scenes: {},
          props: {},
        },
        warnings: [],
        conflict_resolution: "renamed",
        diagnostics: {
          auto_fixed: [],
          warnings: [],
        },
      });

    const { container, location } = renderPage();
    await screen.findByText("暂无项目");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["zip"], "project.zip", { type: "application/zip" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("检测到项目编号重复")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "自动重命名导入" }));

    await waitFor(() => {
      expect(API.importProject).toHaveBeenNthCalledWith(1, file, "prompt");
    });
    await waitFor(() => {
      expect(API.importProject).toHaveBeenNthCalledWith(2, file, "rename");
    });
    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/projects/demo-renamed");
    });
  });
});
