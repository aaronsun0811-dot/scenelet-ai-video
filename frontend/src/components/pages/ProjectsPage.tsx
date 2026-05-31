
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errMsg, voidCall, voidPromise } from "@/utils/async";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  Coins,
  Download,
  EllipsisVertical,
  Film,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  Package,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { AuthenticatedImage } from "@/components/ui/AuthenticatedMedia";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { ArchiveDiagnosticsDialog } from "@/components/shared/ArchiveDiagnosticsDialog";
import { Popover } from "@/components/ui/Popover";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CreateProjectModal } from "./CreateProjectModal";
import { OpenClawModal, type ExternalAgentKind } from "./OpenClawModal";
import { rememberAssetLibraryReturnTo } from "@/utils/asset-library-return";
import { CONTENT_TYPE_PRESETS, isContentTypeId } from "@/data/content-types";
import { getTemplateById } from "@/data/style-templates";
import { getStripeSandboxAssist, onStripeSandboxAssistChange } from "@/utils/stripe-sandbox";
import type { CreditLedgerEntry, CreditOrderResponse, CreditPackage, StripeBillingStatus } from "@/api";
import type { ProjectStatus, ProjectSummary, ImportConflictPolicy, ImportFailureDiagnostics } from "@/types";

type CheckoutNotice = {
  status: "success" | "cancel";
  orderId: string | null;
};

// ---------------------------------------------------------------------------
// Phase display helpers
// ---------------------------------------------------------------------------

function usePhaseLabels() {
  const { t, i18n } = useTranslation();
  return useMemo(
    () => ({
      setup: t("setup"),
      worldbuilding: t("worldbuilding"),
      scripting: t("scripting"),
      production: t("production"),
      completed: t("completed"),
    }) as Record<string, string>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language],
  );
}

// ---------------------------------------------------------------------------
// ProjectCard — clickable project entry
// ---------------------------------------------------------------------------

function ProjectCard({ project, onDelete }: { project: ProjectSummary; onDelete: () => void }) {
  const { t } = useTranslation(["common", "dashboard", "templates"]);
  const [, navigate] = useLocation();
  const status = project.status;
  const hasStatus = status && "current_phase" in status;
  const PHASE_LABELS = usePhaseLabels();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const pct = hasStatus ? Math.round((status as ProjectStatus).phase_progress * 100) : 0;
  const phase = hasStatus ? (status as ProjectStatus).current_phase : "";
  const phaseLabel = PHASE_LABELS[phase] ?? phase;
  const characters = hasStatus ? (status as ProjectStatus).characters : null;
  const scenes = hasStatus ? (status as ProjectStatus).scenes : null;
  const propsStats = hasStatus ? (status as ProjectStatus).props : null;
  const summary = hasStatus ? (status as ProjectStatus).episodes_summary : null;

  // 自定义参考图项目后端会把 style 清空（互斥），仅靠 style_template_id 判断
  // 会落到"未设置"分支。额外看 style_image 才能正确显示"自定义风格"。
  const contentType = isContentTypeId(project.content_type)
    ? CONTENT_TYPE_PRESETS.find((preset) => preset.id === project.content_type)
    : null;
  const contentTypeLabel = contentType ? t(contentType.labelKey) : null;
  const effectiveStyleTemplateId =
    project.style_template_id ?? (!project.style_image ? contentType?.defaultStyleTemplateId : null);
  const styleLabel = effectiveStyleTemplateId
    ? t(`templates:name.${effectiveStyleTemplateId}`)
    : project.style_image
    ? t("dashboard:style_custom")
    : t("dashboard:style_not_set");
  const fallbackTemplate =
    getTemplateById(effectiveStyleTemplateId) ??
    (contentType ? getTemplateById(contentType.defaultStyleTemplateId) : undefined);
  const fallbackThumbnail = fallbackTemplate?.thumbnail;
  const travelSettings = project.content_type === "travel_video" ? project.travel_video_settings : null;
  const travelOrigin = travelSettings?.origin?.trim() ?? "";
  const travelDestination = travelSettings?.destination?.trim() ?? "";
  const travelRoute =
    travelOrigin && travelDestination
      ? `${travelOrigin} → ${travelDestination}`
      : travelOrigin || travelDestination || travelSettings?.route_notes?.trim() || "";
  const projectMetaParts = Array.from(
    new Set([contentTypeLabel, styleLabel, phaseLabel].filter((part): part is string => Boolean(part))),
  );
  const billingMode = project.billing_mode === "platform_credits" ? "platform_credits" : "byok";
  const BillingIcon = billingMode === "platform_credits" ? Coins : KeyRound;
  const isSharedProject = project.current_user_role === "editor";
  const canDeleteProject = !isSharedProject;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app/projects/${project.name}`)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); navigate(`/app/projects/${project.name}`); } }}
      className="relative flex flex-col gap-3 rounded-xl border border-gray-800 bg-gray-900 p-5 text-left transition-colors hover:border-indigo-500/50 hover:bg-gray-800/50 cursor-pointer"
    >
      {/* Thumbnail or placeholder */}
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-gray-800">
        {project.thumbnail ? (
          <AuthenticatedImage
            src={project.thumbnail}
            alt={project.title}
            className="h-full w-full object-cover"
          />
        ) : fallbackThumbnail ? (
          <div className="relative h-full w-full">
            <img
              src={fallbackThumbnail}
              alt={project.title}
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-gray-950/10 via-transparent to-gray-950/85 p-3">
              <div className="flex justify-end">
                <span className="max-w-full truncate rounded-md border border-white/15 bg-gray-950/65 px-2 py-1 text-[11px] text-gray-100 shadow">
                  {contentTypeLabel ?? styleLabel}
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white drop-shadow">{styleLabel}</p>
                {travelRoute && (
                  <p className="mt-1 truncate text-xs text-cyan-100 drop-shadow">
                    {t("dashboard:travel_video_preview_route")}：{travelRoute}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col justify-between border border-gray-700/40 bg-gray-950 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-lg border border-indigo-300/20 bg-indigo-500/10 p-2 text-indigo-200">
                <Film className="h-5 w-5" />
              </span>
              <span className="min-w-0 truncate rounded-md border border-gray-700 bg-gray-900/80 px-2 py-1 text-[11px] text-gray-300">
                {contentTypeLabel ?? t("dashboard:project_list")}
              </span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-gray-100">{t("dashboard:cover_placeholder_title")}</p>
              <p className="mt-1 truncate text-xs text-gray-500">{t("dashboard:cover_placeholder_desc")}</p>
            </div>
          </div>
        )}
      </div>

      {/* Info */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 truncate font-semibold text-gray-100">{project.title}</h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {isSharedProject && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-sky-300/25 bg-sky-400/10 px-1.5 py-0.5 text-[11px] text-sky-100"
                title={
                  project.owner_user_id
                    ? t("dashboard:project_shared_from", { owner: project.owner_user_id })
                    : t("dashboard:project_shared_badge")
                }
              >
                <Users className="h-3 w-3" />
                {t("dashboard:project_shared_badge")}
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
                billingMode === "platform_credits"
                  ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
                  : "border-indigo-300/20 bg-indigo-500/10 text-indigo-100"
              }`}
            >
              <BillingIcon className="h-3 w-3" />
              {billingMode === "platform_credits"
                ? t("dashboard:billing_mode_platform")
                : t("dashboard:billing_mode_byok")}
            </span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{projectMetaParts.join(" · ")}</p>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>{phaseLabel || t("dashboard:progress")}</span>
          <span>{pct}%</span>
        </div>
        <ProgressBar value={pct} barClassName="bg-indigo-600 transition-all" />
      </div>

      {/* Characters, Scenes & Props — always shown */}
      {(characters || scenes || propsStats) && (
        <div className="flex gap-3 text-xs text-gray-500">
          {characters && (
            <span>{t("dashboard:characters")} {characters.completed}/{characters.total}</span>
          )}
          {scenes && (
            <span>{t("dashboard:scenes")} {scenes.completed}/{scenes.total}</span>
          )}
          {propsStats && (
            <span>{t("dashboard:props")} {propsStats.completed}/{propsStats.total}</span>
          )}
        </div>
      )}

      {/* Episodes summary + More actions */}
      <div className="flex items-end justify-between">
        <div className="text-xs text-gray-500">
          {summary && summary.total > 0 && (
            <>
              {summary.total} {t("dashboard:episodes")}
              {summary.scripted > 0 && ` · ${summary.scripted} ${t("dashboard:episodes_scripted")}`}
              {summary.in_production > 0 && ` · ${summary.in_production} ${t("dashboard:episodes_in_production")}`}
              {summary.completed > 0 && ` · ${summary.completed} ${t("dashboard:episodes_completed")}`}
            </>
          )}
        </div>
        {canDeleteProject && (
          <button
            ref={menuAnchorRef}
            type="button"
            aria-label={t("dashboard:more_actions")}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            className="rounded-md p-1 text-gray-500 transition-colors hover:bg-gray-700 hover:text-gray-200"
          >
            <EllipsisVertical className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* More actions popover */}
      {canDeleteProject && (
        <Popover
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={menuAnchorRef}
          width="w-40"
          align="end"
          className="rounded-lg border border-gray-700 shadow-xl py-1"
        >
          {/* stopPropagation prevents portal React event bubbling to card */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
            onKeyDown={(e) => e.stopPropagation()}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-400 transition-colors hover:bg-gray-800"
          >
            <Trash2 className="h-4 w-4" />
            {t("dashboard:delete_project")}
          </button>
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectsPage — project list with create button
// ---------------------------------------------------------------------------

export function ProjectsPage() {
  const { t } = useTranslation(["common", "dashboard", "assets"]);
  const [, navigate] = useLocation();
  const { projects, projectsLoading, showCreateModal, setProjects, setProjectsLoading, setShowCreateModal } =
    useProjectsStore();
  const logout = useAuthStore((s) => s.logout);

  const [importingProject, setImportingProject] = useState(false);
  const [conflictProject, setConflictProject] = useState<string | null>(null);
  const [conflictFile, setConflictFile] = useState<File | null>(null);
  const [importDiagnostics, setImportDiagnostics] = useState<ImportFailureDiagnostics | null>(null);
  const [externalAgent, setExternalAgent] = useState<ExternalAgentKind | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [minimumGenerationBalance, setMinimumGenerationBalance] = useState(1);
  const [pendingPurchaseCredits, setPendingPurchaseCredits] = useState(0);
  const [reservedGenerationCredits, setReservedGenerationCredits] = useState(0);
  const [creditEntries, setCreditEntries] = useState<CreditLedgerEntry[]>([]);
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditPackages, setCreditPackages] = useState<CreditPackage[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [stripeStatus, setStripeStatus] = useState<StripeBillingStatus | null>(null);
  const [stripeStatusLoading, setStripeStatusLoading] = useState(false);
  const [stripeSandboxAssist, setStripeSandboxAssistState] = useState(getStripeSandboxAssist);
  const [orderingPackageId, setOrderingPackageId] = useState<string | null>(null);
  const [confirmingCreditOrderId, setConfirmingCreditOrderId] = useState<string | null>(null);
  const [cancellingCreditOrderId, setCancellingCreditOrderId] = useState<string | null>(null);
  const [creditOrder, setCreditOrder] = useState<CreditOrderResponse | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<CheckoutNotice | null>(null);
  const [checkoutOrder, setCheckoutOrder] = useState<CreditLedgerEntry | null>(null);
  const [checkoutOrderLoading, setCheckoutOrderLoading] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const isConfigComplete = useConfigStatusStore((s) => s.isComplete);
  const fetchConfigStatus = useConfigStatusStore((s) => s.fetch);
  const isCreditBalanceLow = creditBalance !== null && creditBalance < minimumGenerationBalance;

  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await API.listProjects();
      setProjects(res.projects);
    } finally {
      setProjectsLoading(false);
    }
  }, [setProjects, setProjectsLoading]);

  const fetchCreditBalance = useCallback(async () => {
    try {
      const res = await API.getCreditBalance();
      setCreditBalance(res.available_balance ?? res.balance);
      setMinimumGenerationBalance(res.minimum_generation_balance);
      setPendingPurchaseCredits(res.pending_purchase_credits);
      setReservedGenerationCredits(res.reserved_generation_credits ?? 0);
      setCreditEntries(res.entries);
    } catch {
      setCreditBalance(null);
      setMinimumGenerationBalance(1);
      setPendingPurchaseCredits(0);
      setReservedGenerationCredits(0);
      setCreditEntries([]);
    }
  }, []);

  const fetchCreditPackages = useCallback(async () => {
    setPackagesLoading(true);
    try {
      const res = await API.getCreditPackages();
      setCreditPackages(res.packages);
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:credit_packages_load_failed")}${errMsg(err)}`, "warning");
    } finally {
      setPackagesLoading(false);
    }
  }, [t]);

  const fetchStripeStatus = useCallback(async () => {
    setStripeStatusLoading(true);
    try {
      const res = await API.getStripeBillingStatus();
      setStripeStatus(res);
    } catch (err) {
      setStripeStatus(null);
      useAppStore.getState().pushToast(`${t("dashboard:stripe_status_load_failed")}${errMsg(err)}`, "warning");
    } finally {
      setStripeStatusLoading(false);
    }
  }, [t]);

  const refreshCheckoutOrder = useCallback(async (orderId: string | null) => {
    if (!orderId) {
      setCheckoutOrder(null);
      return;
    }
    setCheckoutOrderLoading(true);
    try {
      const entry = await API.getCreditOrder(orderId);
      setCheckoutOrder(entry);
    } catch {
      setCheckoutOrder(null);
    } finally {
      setCheckoutOrderLoading(false);
    }
  }, []);

  const openCreditModal = () => {
    setShowCreditModal(true);
    setCreditOrder(null);
    void fetchCreditPackages();
    void fetchStripeStatus();
  };

  const openAssetLibrary = () => {
    rememberAssetLibraryReturnTo(window.location.pathname);
    navigate("/app/assets");
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("buyCredits") !== "1") return;

    openCreditModal();
    params.delete("buyCredits");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`,
    );
    // Run once on initial page entry; later modal opens are handled by the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;

    if (params.get("createProject") === "1") {
      setShowCreateModal(true);
      params.delete("createProject");
      changed = true;
    }
    if (params.get("importZip") === "1") {
      window.setTimeout(() => importInputRef.current?.click(), 0);
      params.delete("importZip");
      changed = true;
    }
    if (!changed) return;

    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`,
    );
  }, [setShowCreateModal]);

  const handleCreateCreditOrder = async (packageId: string) => {
    setOrderingPackageId(packageId);
    try {
      const order = await API.createCreditOrder({
        package_id: packageId,
        payment_method: getStripeSandboxAssist() ? "manual" : "stripe",
      });
      setCreditOrder(order);
      await fetchCreditBalance();
      if (order.payment_url) {
        window.location.assign(order.payment_url);
      }
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:create_credit_order_failed")}${errMsg(err)}`, "error");
    } finally {
      setOrderingPackageId(null);
    }
  };

  const handleSandboxConfirmCreditOrder = async (orderId: string) => {
    setConfirmingCreditOrderId(orderId);
    try {
      const entry = await API.sandboxConfirmCreditOrder(orderId);
      setCreditOrder((prev) =>
        prev?.order_id === orderId
          ? { ...prev, status: entry.status, ledger_entry: entry }
          : prev,
      );
      await fetchCreditBalance();
      useAppStore.getState().pushToast(t("dashboard:stripe_sandbox_confirmed"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:stripe_sandbox_confirm_failed")}${errMsg(err)}`, "error");
    } finally {
      setConfirmingCreditOrderId(null);
    }
  };

  const handleCancelCreditOrder = async (orderId: string) => {
    setCancellingCreditOrderId(orderId);
    try {
      const entry = await API.cancelCreditOrder(orderId);
      setCreditOrder((prev) =>
        prev?.order_id === orderId
          ? { ...prev, status: entry.status, ledger_entry: entry }
          : prev,
      );
      await fetchCreditBalance();
      useAppStore.getState().pushToast(t("dashboard:credit_order_cancelled"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:credit_order_cancel_failed")}${errMsg(err)}`, "error");
    } finally {
      setCancellingCreditOrderId(null);
    }
  };

  useEffect(() => {
    void fetchProjects();
    void fetchCreditBalance();
    void fetchConfigStatus();
  }, [fetchProjects, fetchCreditBalance, fetchConfigStatus]);

  useEffect(() => onStripeSandboxAssistChange(setStripeSandboxAssistState), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    const orderId = params.get("order_id");

    if (checkout === "success") {
      setCheckoutNotice({ status: "success", orderId });
      useAppStore.getState().pushToast(t("dashboard:stripe_checkout_success"), "success");
      void fetchCreditBalance();
      void refreshCheckoutOrder(orderId);
    } else if (checkout === "cancel") {
      setCheckoutNotice({ status: "cancel", orderId });
      useAppStore.getState().pushToast(t("dashboard:stripe_checkout_cancelled"), "warning");
      void refreshCheckoutOrder(orderId);
    }

    params.delete("checkout");
    params.delete("order_id");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`,
    );
  }, [fetchCreditBalance, refreshCheckoutOrder, t]);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await doImport(file);
    e.target.value = "";
  };

  const doImport = async (file: File, policy: ImportConflictPolicy = "prompt") => {
    setImportingProject(true);
    try {
      const result = await API.importProject(file, policy);
      setConflictProject(null);
      setConflictFile(null);
      setImportDiagnostics(null);
      await fetchProjects();

      const autoFixedCount = result.diagnostics.auto_fixed.length;
      const warningCount = result.diagnostics.warnings.length;
      if (warningCount > 0 || autoFixedCount > 0) {
        useAppStore.getState().pushToast(
          autoFixedCount > 0
            ? t("dashboard:import_auto_fixed", { title: result.project.title || result.project_name, count: autoFixedCount })
            : t("dashboard:import_success", { title: result.project.title || result.project_name }),
          "success"
        );
      }
      navigate(`/app/projects/${result.project_name}`);
    } catch (err) {
      const error = err as Error & {
        status?: number;
        conflict_project_name?: string;
        diagnostics?: ImportFailureDiagnostics;
      };

      if (error.status === 409 && error.conflict_project_name && policy === "prompt") {
        setConflictFile(file);
        setConflictProject(error.conflict_project_name);
        return;
      }

      if (error.diagnostics) {
        setImportDiagnostics(error.diagnostics);
      } else {
        alert(`${t("dashboard:import_failed")}: ${error.message}`);
      }
    } finally {
      setImportingProject(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!deletingProject) return;
    setDeleteLoading(true);
    try {
      await API.deleteProject(deletingProject.name);
      await fetchProjects();
      useAppStore.getState().pushToast(t("common:deleted"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:delete_failed")}[${deletingProject.title}] ${errMsg(err)}`, "warning");
    } finally {
      setDeleteLoading(false);
      setDeletingProject(null);
    }
  };

  return (
    <div className="relative min-h-screen bg-gray-950 text-gray-100">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_20%_0%,rgba(99,102,241,0.14),transparent_55%)] [mask-image:linear-gradient(to_bottom,black_50%,transparent)]"
      />

      {/* Header */}
      <header className="relative border-b border-gray-800/80 bg-gray-950/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
          {/* Left: brand */}
          <h1 className="flex items-center gap-2.5">
            <img
              src="/scenelet-logo-192.png"
              alt="Scenelet"
              className="h-7 w-7 rounded-lg border border-gray-800 bg-gray-900 p-0.5 shadow-md shadow-black/40"
            />
            <span className="text-lg font-semibold tracking-tight text-white">{t("dashboard:app_title")}</span>
            <span className="text-sm font-normal text-gray-500">{t("dashboard:story_workspace_tagline")}</span>
            {projects.length > 0 && (
              <span className="text-xs text-gray-600">· {t("assets:project_count", { count: projects.length })}</span>
            )}
          </h1>

          {/* Right: action groups */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/app/projects")}
              aria-current="page"
              aria-label="顶部创作项目"
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-200 transition-colors hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-white"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("dashboard:projects")}
            </button>

            {/* Asset library pill */}
            <button
              type="button"
              onClick={openAssetLibrary}
              aria-label="顶部资产库"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800"
              title={t("assets:library_title")}
            >
              <Package className="h-3.5 w-3.5" />
              {t("assets:library_title")}
            </button>

            <div className="mx-1 h-5 w-px bg-gray-800" />

            {/* Primary actions */}
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importingProject}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3.5 py-1.5 text-sm font-medium text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {importingProject ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {importingProject ? t("dashboard:importing") : t("dashboard:import_zip")}
            </button>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-lg shadow-indigo-900/40 transition-all hover:bg-indigo-500 hover:shadow-indigo-700/50"
            >
              <Plus className="h-4 w-4" />
              {t("dashboard:create_project")}
            </button>

            <div className="mx-1 h-5 w-px bg-gray-800" />

            {/* Utility */}
            <LanguageSwitch />
            <button
              type="button"
              onClick={() => setExternalAgent("openclaw")}
              className="rounded-md px-2 py-1.5 text-sm text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title="OpenClaw 集成"
              aria-label="OpenClaw 集成指南"
            >
              🦞
            </button>
            <button
              type="button"
              onClick={() => setExternalAgent("hermes")}
              className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title="Hermes Agent 集成"
              aria-label="Hermes Agent 集成指南"
            >
              <img src="/hermes-agent-avatar.svg" alt="" className="h-5 w-5 rounded object-cover" />
            </button>
            <button
              type="button"
              onClick={() => navigate("/app/settings")}
              className="relative rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title={t("settings")}
              aria-label={t("settings")}
            >
              <Settings className="h-4 w-4" />
              {!isConfigComplete && (
                <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-rose-500" aria-label={t("config_incomplete")} />
              )}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title={t("common:logout")}
              aria-label={t("common:logout")}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip"
          aria-label={t("dashboard:import_project_file_aria")}
          onChange={voidPromise(handleImport)}
          className="hidden"
        />
      </header>

      {/* Content */}
      <div className="relative flex">
        <AppSidebar
          activeMain="projects"
          importZipLoading={importingProject}
          onImportZip={() => importInputRef.current?.click()}
          onCreateProject={() => setShowCreateModal(true)}
        />

        <main className="min-w-0 max-w-screen-2xl flex-1 px-6 py-8">
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-gray-800 bg-gray-900/70 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
              <KeyRound className="h-4 w-4" />
            </span>
            <span>{t("dashboard:access_mode_short")}</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${
                isCreditBalanceLow
                  ? "border-red-300/30 bg-red-400/10 text-red-100"
                  : "border-gray-800 bg-gray-950/60 text-gray-300"
              }`}
              title={
                isCreditBalanceLow
                  ? t("dashboard:credit_low_balance_hint", { count: minimumGenerationBalance.toLocaleString() })
                  : t("dashboard:credit_min_generation", { count: minimumGenerationBalance.toLocaleString() })
              }
            >
              {isCreditBalanceLow ? (
                <AlertTriangle className="h-4 w-4 text-red-200" />
              ) : (
                <Coins className="h-4 w-4 text-amber-300" />
              )}
              {t("dashboard:credit_balance", { count: creditBalance ?? "—" })}
              {isCreditBalanceLow && (
                <span className="hidden lg:inline">{t("dashboard:credit_low_balance")}</span>
              )}
              {pendingPurchaseCredits > 0 && (
                <span className="hidden text-amber-100/80 xl:inline">
                  {t("dashboard:credit_pending_purchase", { count: pendingPurchaseCredits.toLocaleString() })}
                </span>
              )}
              {reservedGenerationCredits > 0 && (
                <span className="hidden text-sky-100/80 xl:inline">
                  {t("dashboard:credit_reserved_generation", { count: reservedGenerationCredits.toLocaleString() })}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={openCreditModal}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-100 transition-colors hover:border-amber-200/50 hover:bg-amber-300/15"
            >
              <Coins className="h-4 w-4" />
              {t("dashboard:buy_credits")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/app/settings")}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-200 transition-colors hover:border-indigo-400/50 hover:bg-indigo-500/10"
            >
              <Settings className="h-4 w-4" />
              {t("dashboard:open_api_settings")}
            </button>
          </div>
        </div>
        {checkoutNotice && (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 ${
              checkoutNotice.status === "success"
                ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
                : "border-amber-300/25 bg-amber-300/10 text-amber-100"
            }`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold">
                  {checkoutNotice.status === "success"
                    ? t("dashboard:stripe_checkout_success_title")
                    : t("dashboard:stripe_checkout_cancelled_title")}
                </div>
                <div className="mt-1 text-sm opacity-80">
                  {checkoutNotice.status === "success"
                    ? t("dashboard:stripe_checkout_success_desc")
                    : t("dashboard:stripe_checkout_cancelled_desc")}
                </div>
                {checkoutNotice.orderId && (
                  <div className="mt-2 font-mono text-xs opacity-70">
                    {t("dashboard:stripe_checkout_order_id", { orderId: checkoutNotice.orderId })}
                  </div>
                )}
                {checkoutOrderLoading ? (
                  <div className="mt-2 flex items-center gap-1.5 text-xs opacity-70">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("dashboard:stripe_checkout_order_loading")}
                  </div>
                ) : checkoutOrder ? (
                  <div className="mt-2 text-xs opacity-80">
                    {t("dashboard:stripe_checkout_order_status", {
                      status: t(`dashboard:credit_status_${checkoutOrder.status}`, { defaultValue: checkoutOrder.status }),
                    })}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={voidPromise(async () => {
                    await fetchCreditBalance();
                    await refreshCheckoutOrder(checkoutNotice.orderId);
                  })}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-current/25 px-3 py-2 text-sm font-medium transition-colors hover:bg-white/10"
                >
                  <RefreshCw className="h-4 w-4" />
                  {t("dashboard:refresh_credit_balance")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCheckoutNotice(null);
                    setCheckoutOrder(null);
                  }}
                  className="rounded-lg p-2 opacity-70 transition-colors hover:bg-white/10 hover:opacity-100"
                  aria-label={t("common:close")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}
        {projectsLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
            <span className="ml-2 text-gray-400">{t("dashboard:loading_projects")}</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <FolderOpen className="h-16 w-16 mb-4" />
            <p className="text-lg">{t("dashboard:no_projects")}</p>
            <p className="text-sm mt-1">{t("dashboard:start_creating_hint")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {projects.map((project) => (
              <ProjectCard key={project.name} project={project} onDelete={() => setDeletingProject(project)} />
            ))}
          </div>
        )}
      </main>
      </div>

      {/* Overwrite / Rename Conflict Dialog */}
      {conflictProject && conflictFile && (
        <ConflictDialog
          projectName={conflictProject}
          importing={importingProject}
          onConfirm={(policy) => voidCall(doImport(conflictFile, policy))}
          onCancel={() => {
            setConflictProject(null);
            setConflictFile(null);
          }}
        />
      )}

      {/* Import Diagnostics */}
      {importDiagnostics && (
        <ArchiveDiagnosticsDialog
          title={t("dashboard:export_diagnostics")}
          description={t("dashboard:import_success_with_diagnostics")}
          sections={[
            { key: "blocking", title: t("dashboard:blocking_issues"), tone: "border-red-400/25 bg-red-500/10 text-red-100", items: importDiagnostics.blocking },
            { key: "auto_fixed", title: t("dashboard:auto_fixed_issues"), tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: importDiagnostics.auto_fixable },
            { key: "warnings", title: t("common:error"), tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: importDiagnostics.warnings },
          ]}
          onClose={() => setImportDiagnostics(null)}
        />
      )}
      {externalAgent && <OpenClawModal agent={externalAgent} onClose={() => setExternalAgent(null)} />}
      {showCreateModal && <CreateProjectModal />}
      {showCreditModal && (
        <CreditPurchaseModal
          packages={creditPackages}
          loading={packagesLoading}
          stripeStatus={stripeStatus}
          stripeStatusLoading={stripeStatusLoading}
          stripeSandboxAssist={stripeSandboxAssist}
          balance={creditBalance}
          minimumGenerationBalance={minimumGenerationBalance}
          pendingPurchaseCredits={pendingPurchaseCredits}
          reservedGenerationCredits={reservedGenerationCredits}
          entries={creditEntries}
          orderingPackageId={orderingPackageId}
          confirmingOrderId={confirmingCreditOrderId}
          cancellingOrderId={cancellingCreditOrderId}
          order={creditOrder}
          onOrder={handleCreateCreditOrder}
          onSandboxConfirm={handleSandboxConfirmCreditOrder}
          onCancelOrder={handleCancelCreditOrder}
          onClose={() => setShowCreditModal(false)}
        />
      )}

      {/* Delete project confirmation dialog */}
      {deletingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-gray-100">{t("dashboard:delete_project")}</h2>
                <p className="text-sm leading-6 text-gray-400">
                  {t("dashboard:confirm_delete_project", { title: deletingProject.title })}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeletingProject(null)}
                disabled={deleteLoading}
                className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={voidPromise(handleDeleteProject)}
                disabled={deleteLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleteLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {deleteLoading ? t("dashboard:deleting_project") : t("dashboard:delete_project")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCreditPrice(pkg: CreditPackage) {
  const amount = (pkg.price_minor / 100).toFixed(2);
  if (pkg.currency === "CNY") return `¥${amount}`;
  if (pkg.currency === "USD") return `$${amount}`;
  return `${pkg.currency} ${amount}`;
}

function formatCreditEntryTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function creditAmountClass(entry: CreditLedgerEntry) {
  if (entry.kind === "generation_reservation" && entry.status === "pending") return "text-sky-200";
  return entry.amount >= 0 ? "text-emerald-300" : "text-rose-300";
}

function creditEntryStatusKey(entry: CreditLedgerEntry) {
  if (entry.kind === "generation_reservation" && entry.status === "pending") {
    return "credit_status_reserved";
  }
  return `credit_status_${entry.status}`;
}

function creditEntryStatusClass(entry: CreditLedgerEntry) {
  if (entry.status === "posted") return "bg-emerald-400/10 text-emerald-200";
  if (entry.kind === "generation_reservation" && entry.status === "pending") {
    return "bg-sky-400/10 text-sky-200";
  }
  return "bg-amber-300/10 text-amber-200";
}

function visibleCreditEntries(entries: CreditLedgerEntry[]) {
  return entries.filter((entry) => !(entry.kind === "generation_reservation" && entry.status === "released"));
}

function csvCell(value: string | number | boolean | null | undefined) {
  const text = value == null ? "" : `${value}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCreditEntriesCsv(entries: CreditLedgerEntry[]) {
  const rows = [
    ["created_at", "kind", "status", "amount", "reference_type", "reference_id", "description"],
    ...entries.map((entry) => [
      entry.created_at ?? "",
      entry.kind,
      entry.status,
      entry.amount,
      entry.reference_type ?? "",
      entry.reference_id ?? "",
      entry.description ?? "",
    ]),
  ];
  const csv = `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `scenelet-credit-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function creditEntryCheckoutUrl(entry: CreditLedgerEntry) {
  const metadata = entry.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const url = metadata.stripe_checkout_url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function CreditPurchaseModal({
  packages,
  loading,
  stripeStatus,
  stripeStatusLoading,
  stripeSandboxAssist,
  balance,
  minimumGenerationBalance,
  pendingPurchaseCredits,
  reservedGenerationCredits,
  entries,
  orderingPackageId,
  confirmingOrderId,
  cancellingOrderId,
  order,
  onOrder,
  onSandboxConfirm,
  onCancelOrder,
  onClose,
}: {
  packages: CreditPackage[];
  loading: boolean;
  stripeStatus: StripeBillingStatus | null;
  stripeStatusLoading: boolean;
  stripeSandboxAssist: boolean;
  balance: number | null;
  minimumGenerationBalance: number;
  pendingPurchaseCredits: number;
  reservedGenerationCredits: number;
  entries: CreditLedgerEntry[];
  orderingPackageId: string | null;
  confirmingOrderId: string | null;
  cancellingOrderId: string | null;
  order: CreditOrderResponse | null;
  onOrder: (packageId: string) => Promise<void>;
  onSandboxConfirm: (orderId: string) => Promise<void>;
  onCancelOrder: (orderId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const stripeUnavailable = !stripeSandboxAssist && stripeStatus?.configured === false;
  const canSandboxConfirmOrder =
    Boolean(stripeSandboxAssist && stripeStatus?.sandbox_tools_enabled && order && order.status === "pending" && !order.payment_url);
  const recentEntries = visibleCreditEntries(entries).slice(0, 5);
  const pendingOrders = entries.filter(
    (entry) =>
      entry.kind === "purchase" &&
      entry.status === "pending" &&
      entry.reference_type === "credit_order" &&
      entry.reference_id,
  );
  const canSandboxConfirmPendingOrders = stripeSandboxAssist && Boolean(stripeStatus?.sandbox_tools_enabled);
  const isBalanceLow = balance !== null && balance < minimumGenerationBalance;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-800 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">{t("dashboard:buy_credits")}</h2>
            <p className="mt-1 text-sm leading-6 text-gray-400">
              {t("dashboard:buy_credits_desc")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
            aria-label={t("common:close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          <div
            className={`mb-4 rounded-xl border px-4 py-3 ${
              isBalanceLow
                ? "border-red-300/25 bg-red-400/10"
                : "border-gray-800 bg-gray-950/60"
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-gray-400">{t("dashboard:credit_current_balance")}</span>
              <span className={`text-lg font-semibold ${isBalanceLow ? "text-red-100" : "text-gray-100"}`}>
                {t("dashboard:credits_count", { count: (balance ?? 0).toLocaleString() })}
              </span>
            </div>
            <div className={`mt-1 flex items-center gap-1.5 text-xs ${isBalanceLow ? "text-red-100/80" : "text-gray-500"}`}>
              {isBalanceLow && <AlertTriangle className="h-3.5 w-3.5" />}
              {isBalanceLow
                ? t("dashboard:credit_low_balance_hint", { count: minimumGenerationBalance.toLocaleString() })
                : t("dashboard:credit_min_generation", { count: minimumGenerationBalance.toLocaleString() })}
            </div>
            {pendingPurchaseCredits > 0 && (
              <div className="mt-1 text-xs text-amber-100/80">
                {t("dashboard:credit_pending_purchase", { count: pendingPurchaseCredits.toLocaleString() })}
              </div>
            )}
            {reservedGenerationCredits > 0 && (
              <div className="mt-1 text-xs text-sky-100/80">
                {t("dashboard:credit_reserved_generation", { count: reservedGenerationCredits.toLocaleString() })}
              </div>
            )}
          </div>

          {stripeSandboxAssist ? (
            <div className="mb-4 flex gap-3 rounded-xl border border-indigo-300/25 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">{t("dashboard:stripe_sandbox_assist_active")}</div>
                <div className="mt-1 text-indigo-100/75">
                  {t("dashboard:stripe_sandbox_assist_active_desc")}
                </div>
              </div>
            </div>
          ) : stripeStatusLoading ? (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/60 px-4 py-3 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("dashboard:checking_stripe_status")}
            </div>
          ) : stripeUnavailable ? (
            <div className="mb-4 flex gap-3 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">{t("dashboard:stripe_not_configured")}</div>
                <div className="mt-1 text-amber-100/80">
                  {t("dashboard:stripe_missing_env", { names: stripeStatus.missing.join(", ") })}
                </div>
              </div>
            </div>
          ) : null}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-gray-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("dashboard:loading_credit_packages")}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {packages.map((pkg) => (
                <div
                  key={pkg.id}
                  className="flex min-h-[170px] flex-col rounded-xl border border-gray-800 bg-gray-950/60 p-4"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-300/10 text-amber-200">
                    <Coins className="h-4 w-4" />
                  </div>
                  <div className="mt-4 text-xl font-semibold text-gray-100">
                    {t("dashboard:credits_count", { count: pkg.credits.toLocaleString() })}
                  </div>
                  <div className="mt-1 text-sm text-gray-500">{formatCreditPrice(pkg)}</div>
                  <button
                    type="button"
                    onClick={voidPromise(() => onOrder(pkg.id))}
                    disabled={orderingPackageId !== null || stripeUnavailable || stripeStatusLoading}
                    className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-gray-950 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {orderingPackageId === pkg.id && <Loader2 className="h-4 w-4 animate-spin" />}
                    {orderingPackageId === pkg.id ? t("dashboard:creating_credit_order") : t("dashboard:create_credit_order")}
                  </button>
                </div>
              ))}
            </div>
          )}

          {order && (
            <div className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">
                    {t("dashboard:credit_order_created", { orderId: order.order_id })}
                  </div>
                  <div className="mt-1 text-amber-100/80">
                    {order.payment_url
                      ? t("dashboard:credit_order_redirect_hint")
                      : t("dashboard:credit_order_pending_hint")}
                  </div>
                </div>
                {canSandboxConfirmOrder && (
                  <button
                    type="button"
                    onClick={voidPromise(() => onSandboxConfirm(order.order_id))}
                    disabled={confirmingOrderId !== null}
                    className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-amber-200/40 px-3 py-2 text-xs font-medium text-amber-50 transition-colors hover:bg-amber-200/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {confirmingOrderId === order.order_id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t("dashboard:stripe_sandbox_confirm_order")}
                  </button>
                )}
              </div>
            </div>
          )}

          {pendingOrders.length > 0 && (
            <div className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40">
              <div className="border-b border-gray-800 px-4 py-3">
                <h3 className="text-sm font-medium text-gray-200">{t("dashboard:pending_credit_orders")}</h3>
                <p className="mt-1 text-xs text-gray-500">{t("dashboard:pending_credit_orders_hint")}</p>
              </div>
              <div className="divide-y divide-gray-800">
                {pendingOrders.map((entry) => {
                  const orderId = entry.reference_id ?? "";
                  const checkoutUrl = creditEntryCheckoutUrl(entry);
                  const paymentMethod = typeof entry.metadata?.payment_method === "string"
                    ? entry.metadata.payment_method
                    : null;
                  const canCancelOrder = !checkoutUrl && paymentMethod !== "stripe";
                  return (
                    <div key={entry.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-gray-300">{orderId}</div>
                        <div className="mt-1 text-xs text-gray-500">
                          +{entry.amount.toLocaleString()} · {t("dashboard:credit_status_pending")}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {checkoutUrl && (
                          <button
                            type="button"
                            onClick={() => window.location.assign(checkoutUrl)}
                            className="inline-flex items-center justify-center rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-300/10"
                          >
                            {t("dashboard:continue_payment")}
                          </button>
                        )}
                        {canCancelOrder && (
                          <button
                            type="button"
                            onClick={voidPromise(() => onCancelOrder(orderId))}
                            disabled={cancellingOrderId !== null || confirmingOrderId !== null}
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs font-medium text-gray-300 transition-colors hover:border-red-300/40 hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {cancellingOrderId === orderId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {t("dashboard:credit_order_cancel")}
                          </button>
                        )}
                        {canSandboxConfirmPendingOrders && (
                          <button
                            type="button"
                            onClick={voidPromise(() => onSandboxConfirm(orderId))}
                            disabled={confirmingOrderId !== null}
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs font-medium text-indigo-100 transition-colors hover:border-indigo-300/50 hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {confirmingOrderId === orderId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {t("dashboard:stripe_sandbox_confirm_order")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-5 border-t border-gray-800 pt-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-200">{t("dashboard:credit_recent_entries")}</h3>
              <div className="flex items-center gap-2">
                {entries.length > 0 && (
                  <button
                    type="button"
                    onClick={() => exportCreditEntriesCsv(entries)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:bg-gray-800"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t("dashboard:export_credit_entries")}
                  </button>
                )}
                <span className="text-xs text-gray-500">{t("dashboard:credit_entries_hint")}</span>
              </div>
            </div>
            {recentEntries.length === 0 ? (
              <div className="rounded-xl border border-gray-800 bg-gray-950/40 px-4 py-5 text-center text-sm text-gray-500">
                {t("dashboard:credit_entries_empty")}
              </div>
            ) : (
              <div className="divide-y divide-gray-800 overflow-hidden rounded-xl border border-gray-800 bg-gray-950/40">
                {recentEntries.map((entry) => {
                  const amountText = `${entry.amount > 0 ? "+" : ""}${entry.amount.toLocaleString()}`;
                  return (
                    <div key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-200">
                            {t(`dashboard:credit_kind_${entry.kind}`, { defaultValue: entry.kind })}
                          </span>
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[11px] ${creditEntryStatusClass(entry)}`}
                          >
                            {t(`dashboard:${creditEntryStatusKey(entry)}`, { defaultValue: entry.status })}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-xs text-gray-500">
                          {entry.reference_id || entry.description || formatCreditEntryTime(entry.created_at)}
                        </div>
                      </div>
                      <div className={`shrink-0 text-sm font-semibold ${creditAmountClass(entry)}`}>
                        {amountText}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConflictDialog({
  projectName,
  importing,
  onConfirm,
  onCancel,
}: {
  projectName: string;
  importing: boolean;
  onConfirm: (policy: "overwrite" | "rename") => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-100">{t("dashboard:duplicate_project_id")}</h2>
            <p className="text-sm leading-6 text-gray-400">
              {t("dashboard:id_intended_hint")}
              <span className="mx-1 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-200">
                {projectName}
              </span>
              {t("dashboard:already_exists_conflict_hint")}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3">
          <button
            type="button"
            onClick={() => onConfirm("overwrite")}
            disabled={importing}
            aria-label={t("dashboard:overwrite_existing")}
            className="flex w-full items-center justify-between rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-left text-sm text-red-100 transition-colors hover:border-red-300/40 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">{t("dashboard:overwrite_existing")}</span>
              <span className="mt-1 block text-xs text-red-200/80">
                {t("dashboard:overwrite_hint")}
              </span>
            </span>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          </button>

          <button
            type="button"
            onClick={() => onConfirm("rename")}
            disabled={importing}
            aria-label={t("dashboard:auto_rename_import")}
            className="flex w-full items-center justify-between rounded-xl border border-indigo-400/25 bg-indigo-500/10 px-4 py-3 text-left text-sm text-indigo-100 transition-colors hover:border-indigo-300/40 hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">{t("dashboard:auto_rename_import")}</span>
              <span className="mt-1 block text-xs text-indigo-200/80">
                {t("dashboard:rename_hint")}
              </span>
            </span>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          </button>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={importing}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
