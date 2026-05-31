import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  CreditCard,
  FolderOpen,
  Gauge,
  KeyRound,
  Loader2,
  LogOut,
  Package,
  Plug,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Users,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API, type AdminUserItem, type CreditBalanceResponse, type CreditReconciliationResponse } from "@/api";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { ProjectNamespaceMigrationSection } from "@/components/pages/settings/ProjectNamespaceMigrationSection";
import { StripeSandboxSection } from "@/components/pages/settings/StripeSandboxSection";
import { UsageStatsSection } from "@/components/pages/settings/UsageStatsSection";
import { UserAdminSection } from "@/components/pages/settings/UserAdminSection";
import { ApiKeysTab } from "@/components/pages/ApiKeysTab";
import { ProviderSection } from "@/components/pages/ProviderSection";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { errMsg } from "@/utils/async";
import type { ProjectSummary, ProviderInfo, TaskItem, TaskStats } from "@/types";

type AdminSection = "overview" | "users" | "billing" | "tasks" | "providers" | "api-keys" | "usage" | "maintenance";

type OverviewState = {
  balance: CreditBalanceResponse | null;
  failedTasks: TaskItem[];
  providers: ProviderInfo[];
  projects: ProjectSummary[];
  reconciliation: CreditReconciliationResponse | null;
  taskStats: TaskStats | null;
  users: AdminUserItem[];
};

const emptyOverview: OverviewState = {
  balance: null,
  failedTasks: [],
  providers: [],
  projects: [],
  reconciliation: null,
  taskStats: null,
  users: [],
};

const adminSections: {
  id: AdminSection;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
}[] = [
  { id: "overview", icon: Gauge, labelKey: "admin_overview", descriptionKey: "admin_overview_desc" },
  { id: "users", icon: Users, labelKey: "admin_users", descriptionKey: "admin_users_desc" },
  { id: "billing", icon: CreditCard, labelKey: "admin_billing", descriptionKey: "admin_billing_desc" },
  { id: "tasks", icon: RotateCw, labelKey: "admin_tasks", descriptionKey: "admin_tasks_desc" },
  { id: "providers", icon: Plug, labelKey: "admin_providers", descriptionKey: "admin_providers_desc" },
  { id: "api-keys", icon: KeyRound, labelKey: "admin_api_keys", descriptionKey: "admin_api_keys_desc" },
  { id: "usage", icon: BarChart3, labelKey: "admin_usage", descriptionKey: "admin_usage_desc" },
  { id: "maintenance", icon: Wrench, labelKey: "admin_maintenance", descriptionKey: "admin_maintenance_desc" },
];

function parseSection(search: string): AdminSection {
  const section = new URLSearchParams(search).get("section");
  return adminSections.some((item) => item.id === section) ? (section as AdminSection) : "overview";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusTone(status: string): string {
  if (status === "failed" || status === "error") return "border-red-400/20 bg-red-500/10 text-red-100";
  if (status === "running" || status === "ready") return "border-emerald-400/20 bg-emerald-500/10 text-emerald-100";
  if (status === "queued" || status === "unconfigured") return "border-amber-300/20 bg-amber-300/10 text-amber-100";
  return "border-gray-700 bg-gray-900 text-gray-300";
}

export function AdminPage() {
  const { t } = useTranslation(["common", "dashboard", "assets"]);
  const [, navigate] = useLocation();
  const search = useSearch();
  const logout = useAuthStore((state) => state.logout);
  const section = useMemo(() => parseSection(search), [search]);

  const setSection = (next: AdminSection) => {
    navigate(`/app/admin${next === "overview" ? "" : `?section=${next}`}`, { replace: false });
  };

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const activeMeta = adminSections.find((item) => item.id === section) ?? adminSections[0];

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-800 bg-gray-950">
        <div className="border-b border-gray-800 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-indigo-400/25 bg-indigo-500/10 text-indigo-200">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-sm font-semibold text-white">{t("dashboard:admin_console")}</h1>
              <p className="text-xs text-gray-500">{t("dashboard:admin_console_short")}</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label={t("dashboard:admin_console")}>
          {adminSections.map(({ id, icon: Icon, labelKey, descriptionKey }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? "page" : undefined}
                className={`mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  active
                    ? "border border-indigo-400/25 bg-indigo-500/10 text-indigo-100"
                    : "border border-transparent text-gray-400 hover:border-gray-800 hover:bg-gray-900 hover:text-gray-100"
                }`}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(`dashboard:${labelKey}`)}</span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-gray-500">
                    {t(`dashboard:${descriptionKey}`)}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-gray-800 p-3">
          <Link
            href="/app/projects"
            className="mb-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-900 hover:text-gray-100"
          >
            <ChevronLeft className="h-4 w-4" />
            {t("dashboard:admin_back_to_workspace")}
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-900 hover:text-gray-100"
          >
            <LogOut className="h-4 w-4" />
            {t("common:logout")}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-gray-800 bg-gray-950/90 px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>{t("dashboard:admin_console")}</span>
                <span>/</span>
                <span>{t(`dashboard:${activeMeta.labelKey}`)}</span>
              </div>
              <h2 className="mt-1 text-xl font-semibold text-white">{t(`dashboard:${activeMeta.labelKey}`)}</h2>
              <p className="mt-1 text-sm text-gray-500">{t(`dashboard:${activeMeta.descriptionKey}`)}</p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/app/projects"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-gray-700 hover:bg-gray-800"
              >
                <FolderOpen className="h-4 w-4" />
                {t("dashboard:projects")}
              </Link>
              <Link
                href="/app/assets"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-gray-700 hover:bg-gray-800"
              >
                <Package className="h-4 w-4" />
                {t("assets:library_title")}
              </Link>
              <Link
                href="/app/settings"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-gray-700 hover:bg-gray-800"
              >
                <KeyRound className="h-4 w-4" />
                {t("common:settings")}
              </Link>
              <LanguageSwitch showLabel />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
          {section === "overview" && <AdminOverview onNavigate={setSection} />}
          {section === "users" && <ContentFrame><UserAdminSection /></ContentFrame>}
          {section === "billing" && <ContentFrame><StripeSandboxSection /></ContentFrame>}
          {section === "tasks" && <AdminTasksSection />}
          {section === "providers" && <AdminProvidersSection />}
          {section === "api-keys" && <ContentFrame><ApiKeysTab /></ContentFrame>}
          {section === "usage" && <ContentFrame><UsageStatsSection /></ContentFrame>}
          {section === "maintenance" && <ContentFrame><ProjectNamespaceMigrationSection /></ContentFrame>}
        </main>
      </div>
    </div>
  );
}

function ContentFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-6xl">{children}</div>;
}

function AdminOverview({ onNavigate }: { onNavigate: (section: AdminSection) => void }) {
  const { t } = useTranslation("dashboard");
  const [overview, setOverview] = useState<OverviewState>(emptyOverview);
  const [loading, setLoading] = useState(true);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const [projects, users, stats, failed, reconciliation, providers, balance] = await Promise.all([
        API.listProjects(),
        API.listUsers("", 500),
        API.getTaskStats(),
        API.listTasks({ status: "failed", pageSize: 5 }),
        API.getCreditReconciliation(),
        API.getProviders(),
        API.getCreditBalance(),
      ]);
      setOverview({
        balance,
        failedTasks: failed.items,
        providers: providers.providers,
        projects: projects.projects,
        reconciliation,
        taskStats: stats.stats,
        users,
      });
    } catch (error) {
      useAppStore.getState().pushToast(`${t("admin_overview_load_failed")}${errMsg(error)}`, "error");
      setOverview(emptyOverview);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const readyProviders = overview.providers.filter((provider) => provider.status === "ready").length;
  const providerIssues = overview.providers.length - readyProviders;
  const openCreditIssues = overview.reconciliation?.issues.filter((issue) => !issue.acknowledged).length ?? 0;
  const taskStats = overview.taskStats;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{t("admin_overview_title")}</h3>
          <p className="mt-1 text-sm text-gray-500">{t("admin_overview_subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => { void loadOverview(); }}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 transition-colors hover:border-gray-700 hover:bg-gray-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("admin_refresh")}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t("admin_metric_projects")} value={overview.projects.length} loading={loading} />
        <MetricCard label={t("admin_metric_users")} value={overview.users.length} loading={loading} />
        <MetricCard label={t("admin_metric_running_tasks")} value={taskStats?.running ?? 0} loading={loading} />
        <MetricCard label={t("admin_metric_failed_tasks")} value={taskStats?.failed ?? 0} loading={loading} danger={(taskStats?.failed ?? 0) > 0} />
        <MetricCard label={t("admin_metric_available_credits")} value={overview.balance?.available_balance ?? overview.balance?.balance ?? 0} loading={loading} />
        <MetricCard label={t("admin_metric_pending_credits")} value={overview.balance?.pending_purchase_credits ?? 0} loading={loading} />
        <MetricCard label={t("admin_metric_credit_issues")} value={openCreditIssues} loading={loading} danger={openCreditIssues > 0} />
        <MetricCard label={t("admin_metric_provider_issues")} value={providerIssues} loading={loading} danger={providerIssues > 0} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-100">{t("admin_recent_failures")}</h4>
              <p className="mt-1 text-xs text-gray-500">{t("admin_recent_failures_desc")}</p>
            </div>
            <button type="button" onClick={() => onNavigate("tasks")} className="text-xs text-indigo-300 hover:text-indigo-100">
              {t("admin_view_all")}
            </button>
          </div>
          {overview.failedTasks.length === 0 ? (
            <div className="rounded-lg border border-emerald-400/15 bg-emerald-500/10 p-4 text-sm text-emerald-100">
              {loading ? t("admin_overview_loading") : t("admin_no_failed_tasks")}
            </div>
          ) : (
            <div className="space-y-3">
              {overview.failedTasks.map((task) => (
                <TaskRow key={task.task_id} task={task} compact />
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-100">{t("admin_provider_health_title")}</h4>
              <p className="mt-1 text-xs text-gray-500">{t("admin_provider_health_desc")}</p>
            </div>
            <button type="button" onClick={() => onNavigate("providers")} className="text-xs text-indigo-300 hover:text-indigo-100">
              {t("admin_view_all")}
            </button>
          </div>
          <div className="space-y-2">
            {overview.providers.slice(0, 8).map((provider) => (
              <ProviderHealthRow key={provider.id} provider={provider} />
            ))}
            {!loading && overview.providers.length === 0 && (
              <div className="text-sm text-gray-500">{t("admin_provider_empty")}</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ danger = false, label, loading, value }: { danger?: boolean; label: string; loading: boolean; value: number | string }) {
  return (
    <div className={`rounded-xl border p-4 ${danger ? "border-red-400/20 bg-red-500/10" : "border-gray-800 bg-gray-900/60"}`}>
      <div className="text-xs font-medium uppercase tracking-normal text-gray-500">{label}</div>
      <div className={`mt-3 text-2xl font-semibold tabular-nums ${danger ? "text-red-100" : "text-white"}`}>
        {loading ? "..." : typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function AdminTasksSection() {
  const { t } = useTranslation("dashboard");
  const [status, setStatus] = useState<"all" | TaskItem["status"]>("failed");
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingTaskId, setActingTaskId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await API.listTasks({
        status: status === "all" ? undefined : status,
        pageSize: 50,
      });
      setTasks(result.items);
    } catch (error) {
      useAppStore.getState().pushToast(`${t("admin_tasks_load_failed")}${errMsg(error)}`, "error");
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const retryTask = async (task: TaskItem) => {
    setActingTaskId(task.task_id);
    try {
      await API.retryTask(task.task_id);
      useAppStore.getState().pushToast(t("admin_task_retry_submitted"), "success");
      await loadTasks();
    } catch (error) {
      useAppStore.getState().pushToast(`${t("admin_task_retry_failed")}${errMsg(error)}`, "error");
    } finally {
      setActingTaskId(null);
    }
  };

  const cancelTask = async (task: TaskItem) => {
    setActingTaskId(task.task_id);
    try {
      await API.cancelTask(task.task_id);
      useAppStore.getState().pushToast(t("admin_task_cancelled"), "success");
      await loadTasks();
    } catch (error) {
      useAppStore.getState().pushToast(`${t("admin_task_cancel_failed")}${errMsg(error)}`, "error");
    } finally {
      setActingTaskId(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["failed", "running", "queued", "succeeded", "cancelled", "all"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setStatus(item)}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                status === item
                  ? "bg-indigo-600 text-white"
                  : "border border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700 hover:text-gray-100"
              }`}
            >
              {t(`admin_task_filter_${item}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => { void loadTasks(); }}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 hover:border-gray-700"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("admin_refresh")}
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900/60">
        <div className="grid grid-cols-[1.1fr_8rem_8rem_9rem_12rem] gap-3 border-b border-gray-800 px-4 py-3 text-xs font-medium uppercase text-gray-500">
          <div>{t("admin_task_item")}</div>
          <div>{t("admin_task_status")}</div>
          <div>{t("admin_task_type")}</div>
          <div>{t("admin_task_updated")}</div>
          <div>{t("admin_task_actions")}</div>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("admin_tasks_loading")}
          </div>
        ) : tasks.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-500">{t("admin_tasks_empty")}</div>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.task_id}
              task={task}
              acting={actingTaskId === task.task_id}
              onCancel={task.status === "queued" ? () => { void cancelTask(task); } : undefined}
              onRetry={task.status === "failed" ? () => { void retryTask(task); } : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskRow({
  acting = false,
  compact = false,
  onCancel,
  onRetry,
  task,
}: {
  acting?: boolean;
  compact?: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
  task: TaskItem;
}) {
  const { t } = useTranslation("dashboard");
  if (compact) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-gray-100">{task.project_name} / {task.resource_id}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-gray-500">{task.task_id}</div>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusTone(task.status)}`}>{task.status}</span>
        </div>
        {task.error_message && <p className="mt-2 line-clamp-2 text-xs leading-5 text-red-100/70">{task.error_message}</p>}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[1.1fr_8rem_8rem_9rem_12rem] gap-3 border-b border-gray-800/70 px-4 py-3 text-sm last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-medium text-gray-100">{task.project_name} / {task.resource_id}</div>
        <div className="mt-1 truncate font-mono text-[11px] text-gray-500">{task.task_id}</div>
        {task.error_message && <div className="mt-1 line-clamp-2 text-xs text-red-100/70">{task.error_message}</div>}
      </div>
      <div>
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${statusTone(task.status)}`}>{task.status}</span>
      </div>
      <div className="text-gray-400">{task.task_type}</div>
      <div className="text-xs text-gray-500">{formatDate(task.updated_at)}</div>
      <div className="flex flex-wrap gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={acting}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-400/25 bg-indigo-500/10 px-2 py-1 text-xs text-indigo-100 disabled:opacity-60"
          >
            {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
            {t("admin_task_retry")}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={acting}
            className="inline-flex items-center gap-1 rounded-md border border-red-400/25 bg-red-500/10 px-2 py-1 text-xs text-red-100 disabled:opacity-60"
          >
            {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
            {t("admin_task_cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

function AdminProvidersSection() {
  const { t } = useTranslation("dashboard");

  return (
    <div className="-mx-8 -my-8 min-h-full">
      <div className="border-b border-gray-800 px-8 py-5">
        <h3 className="text-sm font-semibold text-gray-100">{t("admin_provider_config_title")}</h3>
        <p className="mt-1 text-sm text-gray-500">{t("admin_provider_config_desc")}</p>
      </div>
      <ProviderSection />
    </div>
  );
}

function ProviderHealthRow({ detailed = false, provider }: { detailed?: boolean; provider: ProviderInfo }) {
  const { t } = useTranslation("dashboard");
  const Icon = provider.status === "ready" ? CheckCircle2 : AlertTriangle;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-100">{provider.display_name}</div>
          <div className="mt-1 truncate text-xs text-gray-500">{provider.id}</div>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${statusTone(provider.status)}`}>
          <Icon className="h-3 w-3" />
          {t(`admin_provider_status_${provider.status}`)}
        </span>
      </div>
      {detailed && provider.missing_keys.length > 0 && (
        <div className="mt-3 text-xs text-amber-100/75">
          {t("admin_provider_missing_keys")}: {provider.missing_keys.join(", ")}
        </div>
      )}
    </div>
  );
}
