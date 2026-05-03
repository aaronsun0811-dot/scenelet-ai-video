import { startTransition, useState, useEffect, useMemo, useRef } from "react";
import { errMsg, voidPromise } from "@/utils/async";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowRight, ChevronLeft, Activity, Settings, Bell, Coins, Download, KeyRound, Loader2, Package, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import { useUsageStore, type UsageStats } from "@/stores/usage-store";
import { TaskHud } from "@/components/task-hud/TaskHud";
import { UsageDrawer } from "./UsageDrawer";
import { WorkspaceNotificationsDrawer } from "./WorkspaceNotificationsDrawer";
import { ExportScopeDialog } from "./ExportScopeDialog";

import { API } from "@/api";
import { ArchiveDiagnosticsDialog } from "@/components/shared/ArchiveDiagnosticsDialog";
import { ProjectPreExportDialog } from "@/components/shared/ProjectPreExportDialog";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { rememberAssetLibraryReturnTo } from "@/utils/asset-library-return";
import { getProjectWorkflowNextStage } from "@/utils/project-workflow";
import {
  countProjectExportAlerts,
  countProjectExportPreflightIssues,
  firstDeliveryReportIssueEpisode,
  hasTravelRouteAssetManifest,
  prepareProjectExport,
  shouldShowProjectExportPreflightDialog,
  triggerBrowserDownload,
  triggerPreparedProjectDownload,
  type PreparedProjectExport,
  type ProjectExportDownloadResult,
  type ProjectExportScope,
} from "@/utils/project-export";
import {
  buildProjectDeliverySummary,
  hasProjectExportGateIssues,
  type ProjectDeliverySummary,
} from "@/utils/project-delivery";
import type { WorkspaceNotification } from "@/types";

// ---------------------------------------------------------------------------
// Phase definitions
// ---------------------------------------------------------------------------

const PHASES = [
  { key: "setup" },
  { key: "worldbuilding" },
  { key: "scripting" },
  { key: "production" },
  { key: "completed" },
] as const;

// ---------------------------------------------------------------------------
// PhaseStepper — horizontal workflow indicator
// ---------------------------------------------------------------------------

function PhaseStepper({
  currentPhase,
}: {
  currentPhase: string | undefined;
}) {
  const { t } = useTranslation();
  const currentIdx = PHASES.findIndex((p) => p.key === currentPhase);

  return (
    <nav className="flex items-center gap-1" aria-label={t("dashboard:workflow_phases")}>
      {PHASES.map((phase, idx) => {
        const isCompleted = currentIdx > idx;
        const isCurrent = currentIdx === idx;

        // Determine colors
        let circleClass =
          "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold shrink-0 transition-colors";
        let labelClass = "text-xs whitespace-nowrap transition-colors";

        if (isCompleted) {
          circleClass += " bg-emerald-600 text-white";
          labelClass += " text-emerald-400";
        } else if (isCurrent) {
          circleClass += " bg-indigo-600 text-white";
          labelClass += " text-indigo-300 font-medium";
        } else {
          circleClass += " bg-gray-700 text-gray-400";
          labelClass += " text-gray-500";
        }

        return (
          <div key={phase.key} className="flex items-center gap-1">
            {/* Connector line (before each step except the first) */}
            {idx > 0 && (
              <div
                className={`h-px w-4 shrink-0 ${
                  isCompleted ? "bg-emerald-600" : "bg-gray-700"
                }`}
              />
            )}

            {/* Step circle + label */}
            <div className="flex items-center gap-1.5">
              <span className={circleClass}>{idx + 1}</span>
              <span className={labelClass}>{t(phase.key)}</span>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// GlobalHeader
// ---------------------------------------------------------------------------

interface GlobalHeaderProps {
  onNavigateBack?: () => void;
}

export function GlobalHeader({ onNavigateBack }: GlobalHeaderProps) {
  const { t } = useTranslation();
  const [location, setLocation] = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const { currentProjectData, currentProjectName } = useProjectsStore();
  const currentScripts = useProjectsStore((s) => s.currentScripts);
  const { stats, tasks } = useTasksStore();
  const { taskHudOpen, setTaskHudOpen, triggerScrollTo, markWorkspaceNotificationRead, creditReconciliationRevision } =
    useAppStore();
  const { stats: usageStats, setStats: setUsageStats } = useUsageStore();
  const [usageDrawerOpen, setUsageDrawerOpen] = useState(false);
  const [notificationDrawerOpen, setNotificationDrawerOpen] = useState(false);
  const [exportingProject, setExportingProject] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [jianyingExporting, setJianyingExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ProjectExportDownloadResult | null>(null);
  const [backendExportPrompt, setBackendExportPrompt] = useState<PreparedProjectExport | null>(null);
  const [preExportPrompt, setPreExportPrompt] = useState<ProjectDeliverySummary | null>(null);
  const [pendingProjectExportScope, setPendingProjectExportScope] = useState<ProjectExportScope>("current");
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [minimumGenerationBalance, setMinimumGenerationBalance] = useState<number>(1);
  const [pendingPurchaseCredits, setPendingPurchaseCredits] = useState<number>(0);
  const [reservedGenerationCredits, setReservedGenerationCredits] = useState<number>(0);
  const [billingIssueCount, setBillingIssueCount] = useState(0);
  const [billingIssueSeverity, setBillingIssueSeverity] = useState<"error" | "warning" | null>(null);
  const [taskHudDefaultTab, setTaskHudDefaultTab] = useState<"tasks" | "credits">("tasks");
  const usageAnchorRef = useRef<HTMLDivElement>(null);
  const notificationAnchorRef = useRef<HTMLDivElement>(null);
  const taskHudAnchorRef = useRef<HTMLDivElement>(null);
  const exportAnchorRef = useRef<HTMLDivElement>(null);
  const isConfigComplete = useConfigStatusStore((s) => s.isComplete);
  const fetchConfigStatus = useConfigStatusStore((s) => s.fetch);
  const workspaceNotifications = useAppStore((s) => s.workspaceNotifications);

  const currentPhase = currentProjectData?.status?.current_phase;
  const workflowNextStage = getProjectWorkflowNextStage(currentProjectData);
  const isAtProjectOverview =
    location === "/" ||
    Boolean(currentProjectName && location === `/app/projects/${encodeURIComponent(currentProjectName)}`);
  const showWorkflowNextStage =
    Boolean(workflowNextStage) &&
    !(workflowNextStage?.actionPath === "/" && isAtProjectOverview);
  const contentMode = currentProjectData?.content_mode;
  const runningCount = stats.running + stats.queued;
  const taskStatusTooltip =
    billingIssueCount > 0
      ? t("dashboard:task_status_tooltip_with_billing", {
        running: stats.running,
        queued: stats.queued,
        count: billingIssueCount,
      })
      : t("dashboard:task_status_tooltip", { running: stats.running, queued: stats.queued });
  const taskPanelAriaLabel =
    billingIssueCount > 0
      ? t("dashboard:toggle_task_panel_with_billing", { count: billingIssueCount })
      : t("dashboard:toggle_task_panel");
  const displayProjectTitle =
    currentProjectData?.title?.trim() || currentProjectName || t("no_project_selected");
  const unreadNotificationCount = workspaceNotifications.filter((item) => !item.read).length;
  const isPlatformCreditsProject = currentProjectData?.billing_mode === "platform_credits";
  const billingModeText = isPlatformCreditsProject
    ? t("dashboard:billing_mode_platform")
    : t("dashboard:billing_mode_byok");
  const isLowCreditBalance =
    isPlatformCreditsProject && creditBalance !== null && creditBalance < minimumGenerationBalance;
  const projectDeliverySummary = useMemo(
    () =>
      currentProjectName && currentProjectData
        ? buildProjectDeliverySummary(currentProjectData, currentScripts, tasks, currentProjectName)
        : null,
    [currentProjectData, currentProjectName, currentScripts, tasks],
  );
  const backendExportIssueEpisode = firstDeliveryReportIssueEpisode(backendExportPrompt?.deliveryReport);

  // 加载费用统计数据（任务完成时自动刷新）
  const completedTaskCount = stats.succeeded + stats.failed;
  const taskBalanceRefreshKey = [
    stats.queued,
    stats.running,
    stats.succeeded,
    stats.failed,
    stats.cancelled,
    stats.total,
  ].join(":");
  useEffect(() => {
    API.getUsageStats(currentProjectName ? { projectName: currentProjectName } : {})
      .then((res) => {
        setUsageStats(res as unknown as UsageStats);
      })
      .catch(() => {});
  }, [currentProjectName, completedTaskCount, setUsageStats]);

  useEffect(() => {
    let disposed = false;
    if (!isPlatformCreditsProject) {
      setCreditBalance(null);
      setMinimumGenerationBalance(1);
      setPendingPurchaseCredits(0);
      setReservedGenerationCredits(0);
      return () => {
        disposed = true;
      };
    }

    API.getCreditBalance()
      .then((res) => {
        if (!disposed) {
          setCreditBalance(res.available_balance ?? res.balance);
          setMinimumGenerationBalance(res.minimum_generation_balance);
          setPendingPurchaseCredits(res.pending_purchase_credits);
          setReservedGenerationCredits(res.reserved_generation_credits ?? 0);
        }
      })
      .catch(() => {
        if (!disposed) {
          setCreditBalance(null);
          setMinimumGenerationBalance(1);
          setPendingPurchaseCredits(0);
          setReservedGenerationCredits(0);
        }
      });

    return () => {
      disposed = true;
    };
  }, [isPlatformCreditsProject, currentProjectName, taskBalanceRefreshKey]);

  useEffect(() => {
    void fetchConfigStatus();
  }, [fetchConfigStatus]);

  useEffect(() => {
    let disposed = false;
    if (!isPlatformCreditsProject) {
      setBillingIssueCount(0);
      setBillingIssueSeverity(null);
      return () => {
        disposed = true;
      };
    }

    API.getCreditReconciliation()
      .then((res) => {
        if (disposed) return;
        const openIssues = res.issues.filter((issue) => issue.severity !== "info" && !issue.acknowledged);
        setBillingIssueCount(openIssues.length);
        setBillingIssueSeverity(
          openIssues.some((issue) => issue.severity === "error")
            ? "error"
            : openIssues.length > 0
              ? "warning"
              : null,
        );
      })
      .catch(() => {
        if (!disposed) {
          setBillingIssueCount(0);
          setBillingIssueSeverity(null);
        }
      });

    return () => {
      disposed = true;
    };
  }, [creditReconciliationRevision, isPlatformCreditsProject, taskBalanceRefreshKey]);

  const toggleTaskHud = () => {
    const nextOpen = !taskHudOpen;
    if (nextOpen) {
      setTaskHudDefaultTab(billingIssueCount > 0 && runningCount === 0 ? "credits" : "tasks");
    }
    setTaskHudOpen(nextOpen);
  };


  // Format content mode badge text
  const modeLabel = contentMode === "drama" ? t("dashboard:mode_badge_drama") : t("dashboard:mode_badge_narration");
  const aspectRatioLabel =
    typeof currentProjectData?.aspect_ratio === "string" ? currentProjectData.aspect_ratio : "";
  const modeBadgeText = aspectRatioLabel ? `${modeLabel} ${aspectRatioLabel}` : modeLabel;

  // Format cost display – show multi-currency summary
  const costByCurrency = usageStats?.cost_by_currency ?? {};
  const costText = Object.entries(costByCurrency)
    .filter(([, v]) => v > 0)
    .map(([currency, amount]) => `${currency === "CNY" ? "¥" : "$"}${amount.toFixed(2)}`)
    .join(" + ") || "$0.00";

  const handleNotificationNavigate = (notification: WorkspaceNotification) => {
    if (!notification.target) return;
    const target = notification.target;

    markWorkspaceNotificationRead(notification.id);
    setNotificationDrawerOpen(false);
    startTransition(() => {
      setLocation(target.route);
    });
    triggerScrollTo({
      type: target.type,
      id: target.id,
      route: target.route,
      highlight_style: target.highlight_style ?? "flash",
      expires_at: Date.now() + 3000,
    });
  };

  const handleLogout = () => {
    logout();
    setLocation("~/login");
  };

  const handleJianyingExport = async (episode: number, draftPath: string, jianyingVersion: string) => {
    if (!currentProjectName || jianyingExporting) return;

    setJianyingExporting(true);
    try {
      const { download_token } = await API.requestExportToken(currentProjectName, "current");
      const url = API.getJianyingDraftDownloadUrl(
        currentProjectName, episode, draftPath, download_token, jianyingVersion,
      );
      triggerBrowserDownload(url);
      setExportDialogOpen(false);
      useAppStore.getState().pushToast(t("dashboard:jianying_export_started"), "success");
    } catch (err) {
      useAppStore.getState().pushNotification(t("dashboard:jianying_export_failed", { message: errMsg(err) }), "error");
    } finally {
      setJianyingExporting(false);
    }
  };

  const startPreparedExport = (
    prepared: PreparedProjectExport,
    options: { showDiagnosticsAfterDownload?: boolean } = {},
  ) => {
    if (!currentProjectName) return;

    const showDiagnosticsAfterDownload = options.showDiagnosticsAfterDownload ?? true;
    triggerPreparedProjectDownload(currentProjectName, prepared);
    const alertCount = countProjectExportAlerts(prepared);
    if (alertCount > 0) {
      if (showDiagnosticsAfterDownload) {
        setExportResult(prepared);
      }
      useAppStore.getState().pushToast(
        t("dashboard:project_zip_download_started_with_diagnostics", { count: alertCount }),
        "warning",
      );
    } else {
      useAppStore.getState().pushToast(t("dashboard:project_zip_download_started"), "success");
    }
  };

  const performExportProject = async (
    scope: ProjectExportScope,
    options: { skipBackendGate?: boolean } = {},
  ) => {
    if (!currentProjectName || exportingProject) return;

    setPreExportPrompt(null);
    setExportDialogOpen(false);
    setExportingProject(true);
    try {
      const prepared = await prepareProjectExport(currentProjectName, scope);
      if (!options.skipBackendGate && shouldShowProjectExportPreflightDialog(prepared)) {
        setBackendExportPrompt(prepared);
        return;
      }
      startPreparedExport(prepared);
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(t("dashboard:export_failed", { message: errMsg(err) }), "error");
    } finally {
      setExportingProject(false);
    }
  };

  const handleExportProject = async (scope: ProjectExportScope) => {
    if (!currentProjectName || exportingProject) return;

    setExportDialogOpen(false);
    if (projectDeliverySummary && hasProjectExportGateIssues(projectDeliverySummary)) {
      setPendingProjectExportScope(scope);
      setPreExportPrompt(projectDeliverySummary);
      return;
    }

    await performExportProject(scope);
  };

  return (
    <>
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900/80 px-4 backdrop-blur-sm">
      {/* ---- Left section ---- */}
      <div className="flex items-center gap-3">
        {/* Logo */}
        <img src="/scenelet-logo-192.png" alt="Scenelet" className="h-5 w-5" />

        {/* Back to projects */}
        <button
          type="button"
          onClick={onNavigateBack}
          className="flex items-center gap-1 text-sm text-gray-400 transition-colors hover:text-gray-200"
          aria-label={t("dashboard:projects")}
        >
          <ChevronLeft className="h-4 w-4" />
          <span className="hidden sm:inline">{t("dashboard:projects")}</span>
        </button>

        {/* Divider */}
        <div className="h-4 w-px bg-gray-700" />

        {/* Project name */}
        <span className="max-w-48 truncate text-sm font-medium text-gray-200">
          {displayProjectTitle}
        </span>

        {/* Content mode badge */}
        {contentMode && (
          <span className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
            {modeBadgeText}
          </span>
        )}

        {currentProjectData && (
          <span
            className={`hidden items-center gap-1 rounded-full px-2 py-0.5 text-xs sm:inline-flex ${
              isPlatformCreditsProject
                ? "bg-amber-300/10 text-amber-100"
                : "bg-indigo-500/10 text-indigo-100"
            }`}
          >
            {isPlatformCreditsProject ? (
              <Coins className="h-3 w-3" />
            ) : (
              <KeyRound className="h-3 w-3" />
            )}
            {billingModeText}
          </span>
        )}
      </div>

      {/* ---- Center section ---- */}
      <div className="hidden md:flex">
        <PhaseStepper currentPhase={currentPhase} />
      </div>

      {/* ---- Right section ---- */}
      <div className="flex items-center gap-3">
        {showWorkflowNextStage && workflowNextStage && (
          <button
            type="button"
            onClick={() => setLocation(workflowNextStage.actionPath)}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-2 py-1 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15"
            title={t("dashboard:workflow_next_tooltip", {
              phase: t(`dashboard:workflow_phase_${workflowNextStage.key}`),
            })}
            aria-label={t("dashboard:workflow_next_action")}
          >
            <span className="hidden lg:inline">{t("dashboard:workflow_next_action")}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}

        {isPlatformCreditsProject && (
          <div className="inline-flex items-center gap-1.5">
            <span
              className={`hidden items-center gap-1 rounded-md border px-2 py-1 text-xs sm:inline-flex ${
                isLowCreditBalance
                  ? "border-red-300/30 bg-red-400/10 text-red-100"
                  : "border-amber-300/20 bg-amber-300/5 text-amber-100"
              }`}
              title={
                isLowCreditBalance
                  ? t("dashboard:credit_low_balance_hint", { count: minimumGenerationBalance.toLocaleString() })
                  : pendingPurchaseCredits > 0
                    ? t("dashboard:credit_pending_purchase", { count: pendingPurchaseCredits.toLocaleString() })
                    : reservedGenerationCredits > 0
                      ? t("dashboard:credit_reserved_generation", { count: reservedGenerationCredits.toLocaleString() })
                      : undefined
              }
            >
              {isLowCreditBalance ? (
                <AlertTriangle className="h-3.5 w-3.5" />
              ) : (
                <Coins className="h-3.5 w-3.5" />
              )}
              {t("dashboard:credit_balance_compact", {
                count: creditBalance == null ? "—" : creditBalance.toLocaleString(),
              })}
              {isLowCreditBalance && (
                <span className="hidden xl:inline">{t("dashboard:credit_low_balance")}</span>
              )}
              {pendingPurchaseCredits > 0 && !isLowCreditBalance && (
                <span className="hidden xl:inline">
                  {t("dashboard:credit_pending_purchase", { count: pendingPurchaseCredits.toLocaleString() })}
                </span>
              )}
              {reservedGenerationCredits > 0 && pendingPurchaseCredits === 0 && !isLowCreditBalance && (
                <span className="hidden xl:inline">
                  {t("dashboard:credit_reserved_generation", { count: reservedGenerationCredits.toLocaleString() })}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setLocation("~/app/projects?buyCredits=1")}
              className="inline-flex items-center gap-1 rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-xs text-amber-100 transition-colors hover:border-amber-200/50 hover:bg-amber-300/15"
              title={t("dashboard:buy_credits")}
              aria-label={t("dashboard:buy_credits")}
            >
              <Coins className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{t("dashboard:buy_credits")}</span>
            </button>
          </div>
        )}

        <div className="relative" ref={notificationAnchorRef}>
          <button
            type="button"
            onClick={() => setNotificationDrawerOpen(!notificationDrawerOpen)}
            className={`relative flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
              notificationDrawerOpen
                ? "bg-amber-500/20 text-amber-200"
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            }`}
            title={t("dashboard:notification_tooltip", { count: workspaceNotifications.length })}
            aria-label={t("dashboard:open_notification_center")}
          >
            <Bell className="h-3.5 w-3.5" />
            {unreadNotificationCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-950">
                {unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}
              </span>
            )}
          </button>
          <WorkspaceNotificationsDrawer
            open={notificationDrawerOpen}
            onClose={() => setNotificationDrawerOpen(false)}
            anchorRef={notificationAnchorRef}
            onNavigate={handleNotificationNavigate}
          />
        </div>

        {/* Cost badge + UsageDrawer */}
        <div className="relative" ref={usageAnchorRef}>
          <button
            type="button"
            onClick={() => setUsageDrawerOpen(!usageDrawerOpen)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
              usageDrawerOpen
                ? "bg-indigo-500/20 text-indigo-400"
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            }`}
            title={t("dashboard:cost_tooltip", { cost: costText })}
          >
            <span className="font-mono">{costText}</span>
          </button>
          <UsageDrawer
            open={usageDrawerOpen}
            onClose={() => setUsageDrawerOpen(false)}
            projectName={currentProjectName}
            anchorRef={usageAnchorRef}
          />
        </div>

        {/* Task radar + TaskHud popover */}
        <div className="relative" ref={taskHudAnchorRef}>
          <button
            type="button"
            onClick={toggleTaskHud}
            className={`relative rounded-md p-1.5 transition-colors ${
              taskHudOpen
                ? "bg-indigo-500/20 text-indigo-400"
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            }`}
            title={taskStatusTooltip}
            aria-label={taskPanelAriaLabel}
          >
            <Activity
              className={`h-4 w-4 ${runningCount > 0 ? "animate-pulse" : ""}`}
            />
            {/* Running task count badge */}
            {runningCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-500 px-1 text-[10px] font-bold text-white">
                {runningCount}
              </span>
            )}
            {billingIssueCount > 0 && (
              <span
                aria-hidden="true"
                title={t("dashboard:billing_reconciliation_issue_badge", { count: billingIssueCount })}
                className={`absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ring-2 ring-gray-950 ${
                  billingIssueSeverity === "error" ? "bg-red-500" : "bg-amber-500"
                }`}
              >
                {billingIssueCount > 9 ? "9+" : billingIssueCount}
              </span>
            )}
          </button>
          <TaskHud anchorRef={taskHudAnchorRef} defaultTab={taskHudDefaultTab} />
        </div>


        <div className="relative" ref={exportAnchorRef}>
          <button
            type="button"
            onClick={() => setExportDialogOpen(!exportDialogOpen)}
            disabled={!currentProjectName || exportingProject}
            className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={t("dashboard:export_project_zip")}
            aria-label={t("dashboard:export_project_zip")}
          >
            {exportingProject ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span className="hidden lg:inline">
              {exportingProject ? t("dashboard:exporting_zip") : t("dashboard:export_zip")}
            </span>
          </button>
          <ExportScopeDialog
            open={exportDialogOpen}
            onClose={() => setExportDialogOpen(false)}
            onSelect={(scope) => { if (scope !== "jianying-draft") void handleExportProject(scope); }}
            anchorRef={exportAnchorRef}
            episodes={currentProjectData?.episodes ?? []}
            onJianyingExport={voidPromise(handleJianyingExport)}
            jianyingExporting={jianyingExporting}
          />
        </div>

        {/* Asset library */}
        <button
          type="button"
          onClick={() => {
            rememberAssetLibraryReturnTo(window.location.pathname);
            setLocation("~/app/assets");
          }}
          className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          title={t("assets:library_title")}
          aria-label={t("assets:library_title")}
        >
          <Package className="h-4 w-4" />
        </button>

        {/* Settings (placeholder) */}
        <LanguageSwitch className="h-8 px-2" />
        <button
          type="button"
          onClick={() => setLocation(
            currentProjectName
              ? `~/app/projects/${encodeURIComponent(currentProjectName)}/settings`
              : "~/app/settings"
          )}
          className="relative rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
          title={t("settings")}
          aria-label={t("settings")}
        >
          <Settings className="h-4 w-4" />
          {!isConfigComplete && !currentProjectName && (
            <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-rose-500" aria-label={t("dashboard:config_incomplete")} />
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
    </header>

    {exportResult !== null && (
      <ArchiveDiagnosticsDialog
        title={t("dashboard:export_diagnostics_title")}
        description={t("dashboard:export_diagnostics_description")}
        sections={[
          { key: "blocking", title: t("dashboard:diagnostics_blocking"), tone: "border-red-400/25 bg-red-500/10 text-red-100", items: exportResult.diagnostics.blocking },
          { key: "auto_fixed", title: t("dashboard:diagnostics_auto_fixed"), tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: exportResult.diagnostics.auto_fixed },
          { key: "warnings", title: t("dashboard:diagnostics_warnings"), tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: exportResult.diagnostics.warnings },
        ]}
        deliveryReport={exportResult.deliveryReport}
        modelRuleAudit={exportResult.modelRuleAudit}
        deliveryReportFilePrefix={currentProjectName}
        onClose={() => setExportResult(null)}
        onOpenTask={(taskId) => {
          setExportResult(null);
          useAppStore.getState().triggerTaskHudFocus(taskId);
        }}
      />
    )}
    {preExportPrompt !== null && (
      <ProjectPreExportDialog
        summary={preExportPrompt}
        busy={exportingProject}
        handleNextLabel={t("dashboard:project_export_gate_go_fix")}
        onClose={() => setPreExportPrompt(null)}
        onHandleNext={() => {
          setPreExportPrompt(null);
          if (!currentProjectName) return;
          const projectPath = `~/app/projects/${encodeURIComponent(currentProjectName)}`;
          const nextEpisode = preExportPrompt.firstAction?.episode.episode;
          setLocation(nextEpisode ? `${projectPath}/episodes/${nextEpisode}` : projectPath);
        }}
        onConfirmExport={() => void performExportProject(pendingProjectExportScope, { skipBackendGate: true })}
      />
    )}
    {backendExportPrompt !== null && (
      <ArchiveDiagnosticsDialog
        title={t("dashboard:export_preflight_title")}
        description={countProjectExportPreflightIssues(backendExportPrompt) > 0
          ? t("dashboard:export_preflight_description")
          : t("dashboard:project_export_gate_desc_route_assets")}
        sections={[
          { key: "blocking", title: t("dashboard:diagnostics_blocking"), tone: "border-red-400/25 bg-red-500/10 text-red-100", items: backendExportPrompt.diagnostics.blocking },
          { key: "auto_fixed", title: t("dashboard:diagnostics_auto_fixed"), tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: backendExportPrompt.diagnostics.auto_fixed },
          { key: "warnings", title: t("dashboard:diagnostics_warnings"), tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: backendExportPrompt.diagnostics.warnings },
        ]}
        deliveryReport={backendExportPrompt.deliveryReport}
        modelRuleAudit={backendExportPrompt.modelRuleAudit}
        deliveryReportFilePrefix={currentProjectName}
        showCleanDeliveryReport={hasTravelRouteAssetManifest(backendExportPrompt)}
        confirmLabel={countProjectExportPreflightIssues(backendExportPrompt) > 0
          ? t("dashboard:project_export_gate_force_export")
          : t("dashboard:project_export_gate_confirm_export")}
        secondaryLabel={backendExportIssueEpisode !== null ? t("dashboard:project_export_gate_go_fix") : undefined}
        onClose={() => setBackendExportPrompt(null)}
        onOpenTask={(taskId) => {
          setBackendExportPrompt(null);
          useAppStore.getState().triggerTaskHudFocus(taskId);
        }}
        onSecondary={backendExportIssueEpisode !== null
          ? () => {
            const episode = backendExportIssueEpisode;
            setBackendExportPrompt(null);
            if (!currentProjectName) return;
            setLocation(`~/app/projects/${encodeURIComponent(currentProjectName)}/episodes/${episode}`);
          }
          : undefined}
        onConfirm={() => {
          const prepared = backendExportPrompt;
          setBackendExportPrompt(null);
          startPreparedExport(prepared, { showDiagnosticsAfterDownload: false });
        }}
      />
    )}
    </>
  );
}
