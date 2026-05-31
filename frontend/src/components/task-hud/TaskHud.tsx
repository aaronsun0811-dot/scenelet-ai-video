import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { activateOnEnterSpace } from "@/utils/a11y";
import { errMsg, voidPromise } from "@/utils/async";
import { copyText } from "@/utils/clipboard";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, Check, ChevronDown, Coins, Copy, Download, ExternalLink, FileText, ListFilter, Loader2, MapPin, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useLocation } from "wouter";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useTasksStore } from "@/stores/tasks-store";
import {
  API,
  type CreditBalanceResponse,
  type CreditReconciliationAudit,
  type CreditLedgerEntry,
  type CreditReconciliationAction,
  type CreditReconciliationIssue,
  type CreditReconciliationResponse,
} from "@/api";
import type { TaskItem, WorkspaceNotificationTarget } from "@/types";
import { Popover } from "@/components/ui/Popover";

type TaskHudTab = "tasks" | "credits";
type TaskStatusFilter = "all" | "active" | TaskItem["status"];
type TaskTypeFilter = "all" | "storyboard" | "video" | "grid" | "reference_video" | "assets" | "other";
type ReconciliationIssueFilter = "open" | "acknowledged" | "all";
type TaskCreditSummary = {
  reserved: number;
  released: number;
  charged: number;
};
type TaskModelRuleSummary = {
  media_type?: string;
  rule_target?: string;
  mode?: string;
  mode_label?: string;
  target_label?: string;
  skill_name?: string;
  billing_mode?: string;
};
type TaskModelRuleAuditItem = {
  task: TaskItem;
  summary: TaskModelRuleSummary;
  ruleTarget: string | null;
};

const TASK_STATUS_FILTERS: TaskStatusFilter[] = [
  "all",
  "active",
  "queued",
  "running",
  "failed",
  "succeeded",
  "cancelled",
];

const TASK_TYPE_FILTERS: TaskTypeFilter[] = [
  "all",
  "storyboard",
  "video",
  "grid",
  "reference_video",
  "assets",
  "other",
];
const RECONCILIATION_ISSUE_FILTERS: ReconciliationIssueFilter[] = [
  "open",
  "acknowledged",
  "all",
];

function taskMatchesStatusFilter(task: TaskItem, filter: TaskStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return task.status === "queued" || task.status === "running";
  return task.status === filter;
}

function taskMatchesTypeFilter(task: TaskItem, filter: TaskTypeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "assets") return task.task_type === "character" || task.task_type === "scene" || task.task_type === "prop";
  if (filter === "other") {
    return !["storyboard", "video", "grid", "reference_video", "character", "scene", "prop"].includes(task.task_type);
  }
  return task.task_type === filter;
}

function formatCreditNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "-";
}

function formatLedgerAmount(amount: number): string {
  const abs = Math.abs(amount).toLocaleString();
  return amount > 0 ? `+${abs}` : `-${abs}`;
}

function formatLedgerTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function reconciliationAuditTitle(audit: CreditReconciliationAudit, t: TFunction<"dashboard">): string {
  if (audit.action === "release_stale_reservations") {
    return t("credit_reconciliation_audit_release", {
      count: audit.fixed_count,
      skipped: audit.skipped_count,
    });
  }
  if (audit.action === "manual_note") return t("credit_reconciliation_audit_note");
  if (audit.action === "acknowledge_issue") return t("credit_reconciliation_audit_acknowledge");
  if (audit.action === "reopen_issue") return t("credit_reconciliation_audit_reopen");
  return audit.summary || audit.action;
}

function reconciliationIssueKey(issue: CreditReconciliationIssue): string {
  return [
    issue.code,
    issue.reference_type ?? "",
    issue.reference_id ?? "",
    issue.project_name ?? "",
    issue.task_id ?? "",
  ].join("|");
}

function projectRoute(projectName: string): string {
  return `~/app/projects/${encodeURIComponent(projectName)}`;
}

function issueEpisode(issue: CreditReconciliationIssue): number | null {
  const resourceId = issue.resource_id ?? "";
  const match = resourceId.match(/^E(\d+)(?:[A-Z]|$)/i);
  return match ? Number(match[1]) : null;
}

function issueRoute(issue: CreditReconciliationIssue): string | null {
  if (!issue.project_name) return null;
  const baseRoute = projectRoute(issue.project_name);
  const episode = issueEpisode(issue);
  return episode ? `${baseRoute}/episodes/${episode}` : baseRoute;
}

function issueLocatorText(issue: CreditReconciliationIssue): string {
  return [
    `${issue.title} (${issue.code})`,
    issue.project_name ? `project=${issue.project_name}` : null,
    issue.task_id ? `task=${issue.task_id}` : null,
    issue.resource_id ? `resource=${issue.resource_id}` : null,
    issue.reference_type && issue.reference_id ? `${issue.reference_type}=${issue.reference_id}` : null,
    issue.api_call_id ? `api_call=${issue.api_call_id}` : null,
    issue.ledger_entry_id ? `ledger=${issue.ledger_entry_id}` : null,
    issue.created_at ? `created_at=${issue.created_at}` : null,
  ].filter(Boolean).join("\n");
}

function issueLocatorItems(issue: CreditReconciliationIssue, t: TFunction<"dashboard">): Array<{ label: string; value: string }> {
  return [
    issue.project_name ? { label: t("credit_reconciliation_locator_project"), value: issue.project_name } : null,
    issue.task_id ? { label: t("credit_reconciliation_locator_task"), value: issue.task_id } : null,
    issue.resource_id ? { label: t("credit_reconciliation_locator_resource"), value: issue.resource_id } : null,
    issue.api_call_id ? { label: t("credit_reconciliation_locator_api_call"), value: `#${issue.api_call_id}` } : null,
    issue.ledger_entry_id ? { label: t("credit_reconciliation_locator_ledger"), value: `#${issue.ledger_entry_id}` } : null,
    issue.reference_type && issue.reference_id
      ? { label: issue.reference_type, value: issue.reference_id }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function reconciliationReportFilename(): string {
  return `scenelet-reconciliation-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
}

function renderReconciliationCsv(reconciliation: CreditReconciliationResponse | null): string {
  const rows: Array<Array<string | number | boolean | null | undefined>> = [
    [
      "severity",
      "code",
      "acknowledged",
      "title",
      "project",
      "task",
      "resource",
      "reference_type",
      "reference_id",
      "api_call_id",
      "ledger_entry_id",
      "amount",
      "created_at",
      "suggestion",
      "detail",
      "acknowledgement_note",
    ],
    ...(reconciliation?.issues ?? []).map((issue) => [
      issue.severity,
      issue.code,
      Boolean(issue.acknowledged),
      issue.title,
      issue.project_name,
      issue.task_id,
      issue.resource_id,
      issue.reference_type,
      issue.reference_id,
      issue.api_call_id,
      issue.ledger_entry_id,
      issue.amount,
      issue.created_at,
      issue.suggestion,
      issue.detail,
      issue.acknowledgement_note,
    ]),
  ];

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderReconciliationReport(
  reconciliation: CreditReconciliationResponse | null,
  audits: CreditReconciliationAudit[],
  t: TFunction<"dashboard">,
): string {
  const issues = reconciliation?.issues ?? [];
  const openIssues = issues.filter((issue) => issue.severity !== "info" && !issue.acknowledged);
  const acknowledgedIssues = issues.filter((issue) => issue.acknowledged);
  const lines = [
    `# ${t("credit_reconciliation_report_title")}`,
    "",
    `- ${t("credit_reconciliation_report_generated_at")}: ${new Date().toISOString()}`,
    `- ${t("credit_reconciliation_report_status")}: ${reconciliation?.ok ? t("credit_reconciliation_ok") : t("credit_reconciliation_report_needs_attention")}`,
    reconciliation
      ? `- ${t("credit_reconciliation_checked", {
        entries: reconciliation.checked_entries,
        tasks: reconciliation.checked_tasks,
        apiCalls: reconciliation.checked_api_calls,
      })}`
      : null,
    `- ${t("credit_reconciliation_filter_open", { count: openIssues.length })}`,
    `- ${t("credit_reconciliation_filter_acknowledged", { count: acknowledgedIssues.length })}`,
    `- ${t("credit_reconciliation_filter_all", { count: issues.length })}`,
    "",
    `## ${t("credit_reconciliation_report_issues")}`,
    "",
  ].filter((line): line is string => line !== null);

  if (issues.length === 0) {
    lines.push(t("credit_reconciliation_report_no_issues"), "");
  } else {
    issues.forEach((issue, index) => {
      lines.push(
        `### ${index + 1}. ${issue.title}`,
        "",
        `- code: ${issue.code}`,
        `- severity: ${issue.severity}`,
        `- acknowledged: ${Boolean(issue.acknowledged)}`,
        `- amount: ${issue.amount ?? ""}`,
        `- locator: ${issueLocatorText(issue).replace(/\n/g, "; ")}`,
      );
      if (issue.suggestion) lines.push(`- suggestion: ${issue.suggestion}`);
      lines.push(`- detail: ${issue.detail}`, "");
    });
  }

  lines.push(`## ${t("credit_reconciliation_audit_title")}`, "");
  if (audits.length === 0) {
    lines.push(t("credit_reconciliation_audit_empty"), "");
  } else {
    audits.slice(0, 10).forEach((audit) => {
      lines.push(
        `- ${reconciliationAuditTitle(audit, t)}${audit.created_at ? ` (${audit.created_at})` : ""}`,
      );
      if (audit.note) lines.push(`  ${audit.note}`);
    });
  }

  return `${lines.join("\n")}\n`;
}

function getLedgerMetadata(entry: CreditLedgerEntry): Record<string, unknown> {
  return entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
}

function creditEntryMatchesTask(entry: CreditLedgerEntry, task: TaskItem): boolean {
  if (entry.reference_type === "task" && entry.reference_id === task.task_id) {
    return true;
  }

  if (entry.kind !== "generation_usage") return false;
  const metadata = getLedgerMetadata(entry);
  const projectName = typeof metadata.project_name === "string" ? metadata.project_name : null;
  if (projectName && projectName !== task.project_name) return false;

  const resourceId =
    typeof metadata.resource_id === "string"
      ? metadata.resource_id
      : typeof metadata.segment_id === "string"
        ? metadata.segment_id
        : typeof metadata.task_id === "string"
          ? metadata.task_id
          : null;
  if (resourceId !== task.resource_id) return false;

  const callType = typeof metadata.call_type === "string" ? metadata.call_type : null;
  if (callType === "image" && task.media_type !== "image") return false;
  if (callType === "video" && task.media_type !== "video") return false;
  return true;
}

function getTaskCreditEntries(task: TaskItem, entries: readonly CreditLedgerEntry[]): CreditLedgerEntry[] {
  return entries.filter((entry) => creditEntryMatchesTask(entry, task));
}

function summarizeTaskCredits(entries: readonly CreditLedgerEntry[]): TaskCreditSummary {
  return entries.reduce<TaskCreditSummary>(
    (summary, entry) => {
      if (entry.kind === "generation_reservation") {
        const amount = Math.abs(entry.amount);
        if (entry.status === "released") {
          summary.released += amount;
        } else {
          summary.reserved += amount;
        }
      }
      if (entry.kind === "generation_usage" && entry.status === "posted") {
        summary.charged += Math.abs(entry.amount);
      }
      return summary;
    },
    { reserved: 0, released: 0, charged: 0 },
  );
}

function getTaskModelRuleSummary(task: TaskItem): TaskModelRuleSummary | null {
  const raw = task.payload.model_rule_summary;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as TaskModelRuleSummary;
}

function taskMatchesSearchQuery(task: TaskItem, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const summary = getTaskModelRuleSummary(task);
  return [
    task.task_id,
    task.project_name,
    task.task_type,
    task.media_type,
    task.resource_id,
    task.script_file,
    task.status,
    task.source,
    task.error_message,
    summary?.media_type,
    summary?.rule_target,
    summary?.mode,
    summary?.mode_label,
    summary?.target_label,
    summary?.skill_name,
    summary?.billing_mode,
  ].some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
}

function formatTaskModelRuleSummary(
  summary: TaskModelRuleSummary,
  t: TFunction<"dashboard">,
): string {
  const mediaLabel = summary.media_type === "video" ? t("video_generation") : t("image_generation");
  const target = summary.target_label || "-";
  const skillSuffix = summary.skill_name ? ` · ${summary.skill_name}` : "";
  return t("task_model_rule_summary", {
    media: mediaLabel,
    mode: getTaskModelRuleModeLabel(summary, t),
    target,
    skill: skillSuffix,
  });
}

function getTaskModelRuleModeLabel(
  summary: TaskModelRuleSummary,
  t: TFunction<"dashboard">,
): string {
  const mode = typeof summary.mode === "string" ? summary.mode : "";
  if (mode && ["default", "prompt", "github_skill", "uploaded_skill"].includes(mode)) {
    return t(`model_rule_mode_${mode}` as Parameters<typeof t>[0]);
  }
  return summary.mode_label || t("model_rule_mode_default");
}

function getTaskModelRuleBillingLabel(
  summary: TaskModelRuleSummary,
  t: TFunction<"dashboard">,
): string {
  if (summary.billing_mode === "platform_credits") return t("billing_mode_platform");
  if (summary.billing_mode === "byok") return t("billing_mode_byok");
  return t("task_model_rule_unknown_billing");
}

function getTaskModelRuleDetails(
  summary: TaskModelRuleSummary,
  t: TFunction<"dashboard">,
): Array<{ label: string; value: string }> {
  return [
    {
      label: t("task_model_rule_detail_mode"),
      value: getTaskModelRuleModeLabel(summary, t),
    },
    {
      label: t("task_model_rule_detail_target"),
      value: summary.target_label || "-",
    },
    {
      label: t("task_model_rule_detail_skill"),
      value: summary.skill_name || t("task_model_rule_no_skill"),
    },
    {
      label: t("task_model_rule_detail_billing"),
      value: getTaskModelRuleBillingLabel(summary, t),
    },
  ];
}

function getTaskModelRuleTarget(summary: TaskModelRuleSummary | null): string | null {
  const explicitTarget = typeof summary?.rule_target === "string" ? summary.rule_target.trim() : "";
  if (explicitTarget) return explicitTarget;
  if (summary?.media_type === "image" || summary?.media_type === "video") {
    return `__media__/${summary.media_type}`;
  }
  return null;
}

function modelRuleSettingsRoute(ruleTarget: string): string {
  return `~/app/settings?section=media&ruleTarget=${encodeURIComponent(ruleTarget)}`;
}

function getTaskStatusLabel(t: TFunction<"dashboard">, status: TaskItem["status"]): string {
  return {
    running: t("generating_status"),
    queued: t("queued_status"),
    succeeded: t("completed_status"),
    failed: t("failed_status"),
    cancelled: t("cancelled_status"),
  }[status];
}

function taskQueuedTime(task: TaskItem): number {
  const date = new Date(task.queued_at ?? "");
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getTaskModelRuleAuditItems(tasks: readonly TaskItem[]): TaskModelRuleAuditItem[] {
  return tasks
    .map((task) => {
      const summary = getTaskModelRuleSummary(task);
      if (!summary) return null;
      return {
        task,
        summary,
        ruleTarget: getTaskModelRuleTarget(summary),
      };
    })
    .filter((item): item is TaskModelRuleAuditItem => Boolean(item))
    .sort((a, b) => taskQueuedTime(b.task) - taskQueuedTime(a.task));
}

function renderTaskModelRuleAuditText(
  items: readonly TaskModelRuleAuditItem[],
  t: TFunction<"dashboard">,
): string {
  const lines = [
    `# ${t("task_model_rule_audit_title")}`,
    "",
    `- ${t("credit_reconciliation_report_generated_at")}: ${new Date().toISOString()}`,
    `- ${t("task_model_rule_audit_count", { count: items.length })}`,
    "",
  ];
  for (const item of items) {
    const skill = item.summary.skill_name || t("task_model_rule_no_skill");
    const ruleTarget = item.ruleTarget || "-";
    lines.push(
      `## ${item.task.resource_id}`,
      `- project: ${item.task.project_name}`,
      `- task_id: ${item.task.task_id}`,
      `- task_type: ${item.task.task_type}`,
      `- status: ${getTaskStatusLabel(t, item.task.status)}`,
      `- queued_at: ${item.task.queued_at ?? ""}`,
      `- rule: ${getTaskModelRuleModeLabel(item.summary, t)}`,
      `- model: ${item.summary.target_label || "-"}`,
      `- media: ${item.summary.media_type || item.task.media_type}`,
      `- skill: ${skill}`,
      `- billing: ${getTaskModelRuleBillingLabel(item.summary, t)}`,
      `- rule_target: ${ruleTarget}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderTaskFailureReport(
  tasks: readonly TaskItem[],
  t: TFunction<"dashboard">,
): string {
  const lines = [
    `# ${t("task_failure_report_title")}`,
    "",
    `- ${t("credit_reconciliation_report_generated_at")}: ${new Date().toISOString()}`,
    `- ${t("task_failure_report_count", { count: tasks.length })}`,
    "",
  ];

  for (const task of tasks) {
    const summary = getTaskModelRuleSummary(task);
    lines.push(
      `## ${task.resource_id || task.task_id}`,
      `- project: ${task.project_name}`,
      `- task_id: ${task.task_id}`,
      `- task_type: ${task.task_type}`,
      `- media: ${task.media_type}`,
      `- queued_at: ${task.queued_at ?? ""}`,
      `- updated_at: ${task.updated_at ?? ""}`,
      `- script_file: ${task.script_file ?? ""}`,
      `- source: ${task.source ?? ""}`,
    );
    if (summary) {
      lines.push(
        `- rule: ${getTaskModelRuleModeLabel(summary, t)}`,
        `- model: ${summary.target_label || ""}`,
        `- skill: ${summary.skill_name || ""}`,
        `- billing: ${getTaskModelRuleBillingLabel(summary, t)}`,
      );
    }
    lines.push(`- error: ${task.error_message || ""}`, "");
  }

  return `${lines.join("\n")}\n`;
}

export function getTaskLocationTarget(task: TaskItem): WorkspaceNotificationTarget | null {
  const projectPath = `~/app/projects/${encodeURIComponent(task.project_name)}`;

  if (task.task_type === "character") {
    return { type: "character", id: task.resource_id, route: `${projectPath}/characters` };
  }
  if (task.task_type === "scene") {
    return { type: "scene", id: task.resource_id, route: `${projectPath}/scenes` };
  }
  if (task.task_type === "prop") {
    return { type: "prop", id: task.resource_id, route: `${projectPath}/props` };
  }

  if (task.task_type === "storyboard" || task.task_type === "video") {
    const episode = resolveTaskEpisode(task);
    if (!episode) return null;
    return {
      type: "segment",
      id: task.resource_id,
      route: `${projectPath}/episodes/${episode}`,
    };
  }

  if (task.task_type === "reference_video") {
    const episode = resolveTaskEpisode(task);
    if (!episode) return null;
    return {
      type: "reference-unit",
      id: task.resource_id,
      route: `${projectPath}/episodes/${episode}`,
    };
  }

  if (task.task_type === "grid") {
    const episode = resolveTaskEpisode(task);
    const firstSceneId = resolveFirstGridSceneId(task);
    if (!episode || !firstSceneId) return null;
    return {
      type: "segment",
      id: firstSceneId,
      route: `${projectPath}/episodes/${episode}`,
    };
  }

  return null;
}

function resolveTaskEpisode(task: TaskItem): number | null {
  const payloadScriptFile =
    typeof task.payload.script_file === "string" ? task.payload.script_file : "";
  const scriptFile = task.script_file ?? payloadScriptFile;
  const scriptMatch = scriptFile.match(/episode[-_\s]*(\d+)/i);
  if (scriptMatch) return Number(scriptMatch[1]);

  const resourceMatch = task.resource_id.match(/^E(\d+)(?:[A-Z]|$)/i);
  if (resourceMatch) return Number(resourceMatch[1]);

  const payloadEpisode = task.payload.episode;
  return typeof payloadEpisode === "number" && Number.isFinite(payloadEpisode)
    ? payloadEpisode
    : null;
}

function resolveFirstGridSceneId(task: TaskItem): string | null {
  const sceneIds = task.payload.scene_ids;
  if (!Array.isArray(sceneIds)) return null;
  const first = sceneIds.find((value): value is string => typeof value === "string" && value.length > 0);
  return first ?? null;
}

function getTaskTypeLabel(t: TFunction<"dashboard">, taskType: string): string {
  const key = `task_type_${taskType}`;
  const translated = t(key);
  return translated === key ? taskType : translated;
}

function getCreditKindLabel(t: TFunction<"dashboard">, kind: string): string {
  const key = `credit_kind_${kind}`;
  const translated = t(key);
  return translated === key ? kind : translated;
}

function getCreditStatusLabel(t: TFunction<"dashboard">, status: string, kind?: string): string {
  const normalizedStatus = kind === "generation_reservation" && status === "pending" ? "reserved" : status;
  const key = `credit_status_${normalizedStatus}`;
  const translated = t(key);
  return translated === key ? normalizedStatus : translated;
}

// ---------------------------------------------------------------------------
// Task status icon — visual indicator per task state
// ---------------------------------------------------------------------------

function TaskStatusIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />;
    case "queued":
      return <div className="h-2 w-2 rounded-full bg-gray-500" />;
    case "succeeded":
      return <Check className="h-3.5 w-3.5 text-emerald-400" />;
    case "failed":
      return <X className="h-3.5 w-3.5 text-red-400" />;
    case "cancelled":
      return <X className="h-3.5 w-3.5 text-gray-400" />;
  }
}

// ---------------------------------------------------------------------------
// RunningProgressBar — 运行中任务的动态进度条
// ---------------------------------------------------------------------------

function RunningProgressBar() {
  return (
    <div className="relative mt-1 h-0.5 w-full overflow-hidden rounded-full bg-gray-800">
      <motion.div
        className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-indigo-500"
        animate={{ x: ["0%", "200%"] }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskRow — 单个任务条目（含完成高亮、失败展开、运行进度条）
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  isFading,
  highlighted = false,
  expandedErrorId,
  onToggleError,
  onCancel,
  onLocate,
  onOpenModelRule,
  onRetry,
  retrying,
  creditEntries = [],
}: {
  task: TaskItem;
  isFading: boolean;
  highlighted?: boolean;
  expandedErrorId: string | null;
  onToggleError: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onLocate?: (task: TaskItem) => void;
  onOpenModelRule?: (ruleTarget: string) => void;
  onRetry?: (taskId: string) => void;
  retrying?: boolean;
  creditEntries?: CreditLedgerEntry[];
}) {
  const { t } = useTranslation("dashboard");
  const statusColor: Record<TaskItem["status"], string> = {
    running: "text-indigo-400",
    queued: "text-gray-500",
    succeeded: "text-emerald-400",
    failed: "text-red-400",
    cancelled: "text-gray-400",
  };

  // 根据状态确定行背景样式
  const rowBg =
    task.status === "failed"
      ? "bg-red-500/10"
      : task.status === "succeeded" && !isFading
        ? "bg-emerald-500/10"
        : "";

  const isErrorExpanded = expandedErrorId === task.task_id;
  const hasError = task.status === "failed" && task.error_message;
  const canLocate = Boolean(onLocate && getTaskLocationTarget(task));
  const taskTypeLabel = getTaskTypeLabel(t, task.task_type);
  const taskCreditEntries = getTaskCreditEntries(task, creditEntries);
  const creditSummary = summarizeTaskCredits(taskCreditEntries);
  const hasCreditSummary =
    creditSummary.reserved > 0 || creditSummary.released > 0 || creditSummary.charged > 0;
  const modelRuleSummary = getTaskModelRuleSummary(task);
  const modelRuleDetails = modelRuleSummary ? getTaskModelRuleDetails(modelRuleSummary, t) : [];
  const modelRuleTarget = getTaskModelRuleTarget(modelRuleSummary);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{
        opacity: isFading ? 0 : 1,
        height: isFading ? 0 : "auto",
      }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: isFading ? 0.4 : 0.2 }}
      className="overflow-hidden"
    >
      {/* 主行内容 */}
      <div
        data-task-id={task.task_id}
        aria-current={highlighted ? "true" : undefined}
        className={`flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
          highlighted ? "bg-sky-400/10 ring-1 ring-inset ring-sky-300/45" : rowBg
        } ${
          hasError ? "cursor-pointer hover:bg-red-500/15" : ""
        }`}
        role={hasError ? "button" : undefined}
        tabIndex={hasError ? 0 : undefined}
        onClick={hasError ? () => onToggleError(task.task_id) : undefined}
        onKeyDown={hasError ? activateOnEnterSpace(() => onToggleError(task.task_id)) : undefined}
      >
        <TaskStatusIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs text-gray-300">
              {task.resource_id}
            </span>
            <span className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-400">
              {taskTypeLabel}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-gray-600">
            <span className="truncate">{task.project_name}</span>
            <span className="shrink-0">{formatLedgerTime(task.queued_at)}</span>
          </div>
          {modelRuleSummary && (
            <div className="mt-1 rounded-md border border-indigo-500/20 bg-indigo-500/5 px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-indigo-200/90">
                <FileText className="h-3 w-3 shrink-0 text-indigo-300" />
                <span className="truncate font-medium">{formatTaskModelRuleSummary(modelRuleSummary, t)}</span>
                {modelRuleTarget && onOpenModelRule && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenModelRule(modelRuleTarget);
                    }}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-indigo-400/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-100 transition-colors hover:border-indigo-300/40 hover:bg-indigo-500/20 focus-ring"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    {t("task_model_rule_open")}
                  </button>
                )}
              </div>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] sm:grid-cols-4">
                {modelRuleDetails.map((item) => (
                  <div key={item.label} className="min-w-0">
                    <dt className="text-gray-600">{item.label}</dt>
                    <dd className="truncate text-gray-300" title={item.value}>
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {hasCreditSummary && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <Coins className="h-3 w-3 text-amber-300" />
              {creditSummary.reserved > 0 && (
                <span className="text-amber-300">
                  {t("task_credit_reserved", { count: formatCreditNumber(creditSummary.reserved) })}
                </span>
              )}
              {creditSummary.released > 0 && (
                <span className="text-gray-500">
                  {t("task_credit_released", { count: formatCreditNumber(creditSummary.released) })}
                </span>
              )}
              {creditSummary.charged > 0 && (
                <span className="text-emerald-300">
                  {t("task_credit_charged", { count: formatCreditNumber(creditSummary.charged) })}
                </span>
              )}
            </div>
          )}
        </div>
        <span className={`text-xs ${statusColor[task.status]}`}>
          {getTaskStatusLabel(t, task.status)}
        </span>
        {canLocate && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLocate?.(task);
            }}
            className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-700 hover:text-sky-300 focus-ring"
            title={t("view_location")}
            aria-label={t("view_location")}
          >
            <MapPin className="h-3.5 w-3.5" />
          </button>
        )}
        {task.status === "queued" && onCancel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel(task.task_id);
            }}
            className="ml-1 rounded px-1 py-0.5 text-xs text-gray-500 hover:bg-gray-700 hover:text-gray-300"
            title={t("cancel_task")}
            aria-label={t("cancel_this_task")}
          >
            {t("cancel_btn")}
          </button>
        )}
        {task.status === "failed" && onRetry && (
          <button
            type="button"
            disabled={retrying}
            onClick={(e) => {
              e.stopPropagation();
              onRetry(task.task_id);
            }}
            className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-700 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
            title={t("retry_task")}
            aria-label={t("retry_this_task")}
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {task.status === "cancelled" && task.cancelled_by === "cascade" && (
          <span className="ml-1 text-xs text-gray-500">{t("cascade_label")}</span>
        )}
        {hasError && (
          <ChevronDown
            className={`h-3 w-3 text-gray-500 transition-transform ${
              isErrorExpanded ? "rotate-180" : ""
            }`}
          />
        )}
      </div>

      {/* 运行中任务的进度条 */}
      {task.status === "running" && (
        <div className="px-3 pb-1">
          <RunningProgressBar />
        </div>
      )}

      {/* 失败任务的错误详情展开区域 */}
      <AnimatePresence>
        {hasError && isErrorExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="mx-3 mb-1.5 rounded bg-red-500/5 px-2 py-1.5 text-xs text-red-300/80">
              {task.error_message}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// ChannelSection — 按图片/视频通道分组，含自动淡出逻辑
// ---------------------------------------------------------------------------

function ChannelSection({
  title,
  icon: Icon,
  tasks,
  highlightedTaskId,
  onCancel,
  onLocate,
  onOpenModelRule,
  onRetry,
  retryingTaskIds,
  creditEntries = [],
  recentLimit = 5,
  autoFadeCompleted = true,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tasks: TaskItem[];
  highlightedTaskId?: string | null;
  onCancel?: (taskId: string) => void;
  onLocate?: (task: TaskItem) => void;
  onOpenModelRule?: (ruleTarget: string) => void;
  onRetry?: (taskId: string) => void;
  retryingTaskIds?: Set<string>;
  creditEntries?: CreditLedgerEntry[];
  recentLimit?: number;
  autoFadeCompleted?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  // 跟踪正在淡出的任务 ID
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());
  // 跟踪已完全淡出（应隐藏）的任务 ID
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // 保存定时器引用以便清理
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 失败任务错误详情展开状态
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);

  const toggleError = useCallback((taskId: string) => {
    setExpandedErrorId((prev) => (prev === taskId ? null : taskId));
  }, []);

  // 监听任务状态变化，为 succeeded/cancelled 任务设置自动淡出
  useEffect(() => {
    if (!autoFadeCompleted) return;
    const autoFadeTasks = tasks.filter(
      (t) =>
        (t.status === "succeeded" || t.status === "cancelled") &&
        !fadingIds.has(t.task_id) &&
        !hiddenIds.has(t.task_id),
    );

    for (const task of autoFadeTasks) {
      if (timersRef.current.has(task.task_id)) continue;

      // 3 秒后开始淡出动画
      const fadeTimer = setTimeout(() => {
        setFadingIds((prev) => new Set(prev).add(task.task_id));

        // 淡出动画完成后（400ms）标记为隐藏
        const hideTimer = setTimeout(() => {
          setHiddenIds((prev) => new Set(prev).add(task.task_id));
          timersRef.current.delete(task.task_id);
        }, 400);

        timersRef.current.set(task.task_id + "_hide", hideTimer);
      }, 3000);

      timersRef.current.set(task.task_id, fadeTimer);
    }

    const timers = timersRef.current;
    return () => {
      // 组件卸载时清理所有定时器
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, [autoFadeCompleted, tasks, fadingIds, hiddenIds]);

  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const recent = tasks
    .filter((t) => t.status === "succeeded" || t.status === "failed" || t.status === "cancelled")
    .filter((t) => !hiddenIds.has(t.task_id))
    .slice(0, recentLimit);

  const visible = [...running, ...queued, ...recent];

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-gray-400">
        <Icon className="h-3.5 w-3.5" />
        {title}
        {running.length > 0 && (
          <span className="ml-auto text-indigo-400">
            {t("running_count", { count: running.length })}
          </span>
        )}
      </div>
      <AnimatePresence>
        {visible.map((task) => (
          <TaskRow
            key={task.task_id}
            task={task}
            isFading={fadingIds.has(task.task_id)}
            highlighted={highlightedTaskId === task.task_id}
            expandedErrorId={expandedErrorId}
            onToggleError={toggleError}
            onCancel={onCancel}
            onLocate={onLocate}
            onOpenModelRule={onOpenModelRule}
            onRetry={onRetry}
            retrying={retryingTaskIds?.has(task.task_id)}
            creditEntries={creditEntries}
          />
        ))}
      </AnimatePresence>
      {visible.length === 0 && (
        <div className="px-3 py-2 text-xs text-gray-600">{t("no_tasks")}</div>
      )}
    </div>
  );
}

function ModelRuleAuditPanel({
  tasks,
  onOpenModelRule,
  onCopyAudit,
}: {
  tasks: TaskItem[];
  onOpenModelRule?: (ruleTarget: string) => void;
  onCopyAudit: (items: TaskModelRuleAuditItem[]) => Promise<void>;
}) {
  const { t } = useTranslation("dashboard");
  const auditItems = useMemo(() => getTaskModelRuleAuditItems(tasks), [tasks]);
  const visibleItems = auditItems.slice(0, 6);
  const hiddenCount = Math.max(0, auditItems.length - visibleItems.length);

  return (
    <div className="border-b border-gray-800 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-300">
            <FileText className="h-3.5 w-3.5 text-indigo-300" />
            {t("task_model_rule_audit_title")}
            <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] font-normal text-gray-500">
              {t("task_model_rule_audit_count", { count: auditItems.length })}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-gray-600">{t("task_model_rule_audit_desc")}</p>
        </div>
        <button
          type="button"
          onClick={voidPromise(() => onCopyAudit(auditItems))}
          disabled={auditItems.length === 0}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
        >
          <Copy className="h-3 w-3" />
          {t("task_model_rule_audit_copy")}
        </button>
      </div>

      {visibleItems.length > 0 ? (
        <div className="mt-2 divide-y divide-gray-800/60 rounded-md border border-gray-800 bg-gray-950/50">
          {visibleItems.map((item) => {
            const mediaLabel = item.summary.media_type === "video" ? t("video_generation") : t("image_generation");
            const skill = item.summary.skill_name || t("task_model_rule_no_skill");
            return (
              <div key={item.task.task_id} className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs">
                <span className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-500">
                  {getTaskStatusLabel(t, item.task.status)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-gray-200">{item.task.resource_id}</span>
                    <span className="shrink-0 text-[11px] text-gray-600">{formatLedgerTime(item.task.queued_at)}</span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500">
                    <span>{mediaLabel}</span>
                    <span className="text-indigo-200">{getTaskModelRuleModeLabel(item.summary, t)}</span>
                    <span className="max-w-[13rem] truncate text-gray-300" title={item.summary.target_label || "-"}>
                      {item.summary.target_label || "-"}
                    </span>
                    <span title={skill}>{t("task_model_rule_audit_skill", { skill })}</span>
                    <span>{getTaskModelRuleBillingLabel(item.summary, t)}</span>
                  </div>
                </div>
                {item.ruleTarget && onOpenModelRule && (
                  <button
                    type="button"
                    onClick={() => onOpenModelRule(item.ruleTarget as string)}
                    className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-indigo-200 focus-ring"
                    aria-label={t("task_model_rule_open")}
                    title={t("task_model_rule_open")}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <div className="px-2 py-1.5 text-[11px] text-gray-600">
              {t("task_model_rule_audit_more", { count: hiddenCount })}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2 rounded-md border border-dashed border-gray-800 px-2 py-2 text-xs text-gray-600">
          {t("task_model_rule_audit_empty")}
        </p>
      )}
    </div>
  );
}

function BatchTaskActionsPanel({
  failedTasks,
  queuedTasks,
  retrying,
  onRetryFailed,
  onCopyFailureReport,
  onCancelQueued,
}: {
  failedTasks: TaskItem[];
  queuedTasks: TaskItem[];
  retrying: boolean;
  onRetryFailed: () => Promise<void>;
  onCopyFailureReport: () => Promise<void>;
  onCancelQueued: () => void;
}) {
  const { t } = useTranslation("dashboard");
  if (failedTasks.length === 0 && queuedTasks.length === 0) return null;

  return (
    <div className="border-b border-gray-800 px-3 py-2">
      <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-300">{t("task_batch_actions_title")}</p>
            <p className="mt-0.5 text-[11px] text-gray-600">
              {t("task_batch_actions_desc", {
                failed: failedTasks.length,
                queued: queuedTasks.length,
              })}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <button
              type="button"
              onClick={voidPromise(onRetryFailed)}
              disabled={failedTasks.length === 0 || retrying}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-100 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
            >
              {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              {t("task_batch_retry_failed", { count: failedTasks.length })}
            </button>
            <button
              type="button"
              onClick={voidPromise(onCopyFailureReport)}
              disabled={failedTasks.length === 0}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-gray-700 px-2 text-[11px] font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
            >
              <Copy className="h-3 w-3" />
              {t("task_batch_copy_failures")}
            </button>
            <button
              type="button"
              onClick={onCancelQueued}
              disabled={queuedTasks.length === 0}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-red-400/25 bg-red-500/10 px-2 text-[11px] font-medium text-red-100 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
            >
              <X className="h-3 w-3" />
              {t("task_batch_cancel_queued", { count: queuedTasks.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreditLedgerRow({ entry }: { entry: CreditLedgerEntry }) {
  const { t } = useTranslation("dashboard");
  const amountTone = entry.amount > 0
    ? "text-emerald-300"
    : entry.status === "released"
      ? "text-gray-500"
      : "text-amber-300";
  const description = entry.description || entry.reference_id || t("credit_entry_no_description");

  return (
    <div className="flex items-start gap-3 border-t border-gray-800/60 px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-gray-200">{description}</span>
          <span className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-500">
            {getCreditStatusLabel(t, entry.status, entry.kind)}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-600">
          <span>{getCreditKindLabel(t, entry.kind)}</span>
          {entry.reference_id && <span className="font-mono">{entry.reference_id}</span>}
          {entry.created_at && <span>{formatLedgerTime(entry.created_at)}</span>}
        </div>
      </div>
      <span className={`shrink-0 font-mono ${amountTone}`}>
        {formatLedgerAmount(entry.amount)}
      </span>
    </div>
  );
}

function CreditReconciliationPanel({
  reconciliation,
  audits,
  loading,
  fixingAction,
  acknowledgingIssueKey,
  reopeningIssueKey,
  savingNote,
  onRunAction,
  onAcknowledgeIssue,
  onReopenIssue,
  onLocateIssue,
  onCopyIssueLocator,
  onCopyReport,
  onExportCsv,
  onAddNote,
}: {
  reconciliation: CreditReconciliationResponse | null;
  audits: CreditReconciliationAudit[];
  loading: boolean;
  fixingAction: CreditReconciliationAction | null;
  acknowledgingIssueKey: string | null;
  reopeningIssueKey: string | null;
  savingNote: boolean;
  onRunAction: (action: CreditReconciliationAction) => Promise<void>;
  onAcknowledgeIssue: (issue: CreditReconciliationIssue) => Promise<void>;
  onReopenIssue: (issue: CreditReconciliationIssue) => Promise<void>;
  onLocateIssue: (issue: CreditReconciliationIssue) => void;
  onCopyIssueLocator: (issue: CreditReconciliationIssue) => Promise<void>;
  onCopyReport: () => Promise<void>;
  onExportCsv: () => void;
  onAddNote: (note: string) => Promise<void>;
}) {
  const { t } = useTranslation("dashboard");
  const [note, setNote] = useState("");
  const [issueFilter, setIssueFilter] = useState<ReconciliationIssueFilter>("open");
  const issues = reconciliation?.issues ?? [];
  const blockingIssues = issues.filter((issue) => issue.severity !== "info" && !issue.acknowledged);
  const acknowledgedIssues = issues.filter((issue) => issue.acknowledged);
  const filteredIssues = issueFilter === "open"
    ? blockingIssues
    : issueFilter === "acknowledged"
      ? acknowledgedIssues
      : issues;
  const visibleIssues = filteredIssues.slice(0, 6);
  const trimmedNote = note.trim();
  const actions = Array.from(
    issues.reduce((map, issue) => {
      if (issue.action && !issue.acknowledged) {
        map.set(
          issue.action,
          issue.action_label || t("credit_reconciliation_fix_release_stale"),
        );
      }
      return map;
    }, new Map<CreditReconciliationAction, string>()),
  ).map(([action, label]) => ({ action, label }));

  const tone = blockingIssues.some((issue) => issue.severity === "error")
    ? "border-red-400/25 bg-red-500/10 text-red-100"
    : blockingIssues.length > 0
      ? "border-amber-400/25 bg-amber-500/10 text-amber-100"
      : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100";

  return (
    <div className="border-t border-gray-800 px-3 py-3">
      <div className={`rounded-lg border px-3 py-2 ${tone}`}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold">{t("credit_reconciliation_title")}</p>
          <span className="text-[11px] opacity-80">
            {loading
              ? t("credit_reconciliation_loading")
              : reconciliation?.ok
                ? t("credit_reconciliation_ok")
                : t("credit_reconciliation_issue_count", { count: blockingIssues.length })}
          </span>
        </div>
        {reconciliation && (
          <p className="mt-1 text-[11px] opacity-70">
            {t("credit_reconciliation_checked", {
              entries: reconciliation.checked_entries,
              tasks: reconciliation.checked_tasks,
              apiCalls: reconciliation.checked_api_calls,
            })}
          </p>
        )}
        {reconciliation && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={voidPromise(onCopyReport)}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300/20 bg-gray-950/20 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-gray-950/35 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FileText className="h-3 w-3" />
              {t("credit_reconciliation_report_copy")}
            </button>
            <button
              type="button"
              onClick={onExportCsv}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300/20 bg-gray-950/20 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-gray-950/35 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Download className="h-3 w-3" />
              {t("credit_reconciliation_report_export_csv")}
            </button>
          </div>
        )}
        {actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {actions.map(({ action, label }) => {
              const fixing = fixingAction === action;
              return (
                <button
                  key={action}
                  type="button"
                  onClick={voidPromise(() => onRunAction(action))}
                  disabled={loading || fixingAction !== null}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-[11px] font-medium text-amber-50 transition-colors hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {fixing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  {fixing ? t("credit_reconciliation_fixing") : label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {issues.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 rounded-lg border border-gray-800 bg-gray-950/50 p-1">
          {RECONCILIATION_ISSUE_FILTERS.map((filter) => {
            const active = issueFilter === filter;
            const count = filter === "open"
              ? blockingIssues.length
              : filter === "acknowledged"
                ? acknowledgedIssues.length
                : issues.length;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setIssueFilter(filter)}
                className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                  active
                    ? "bg-indigo-500/20 text-indigo-100"
                    : "text-gray-500 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                {t(`credit_reconciliation_filter_${filter}`, { count })}
              </button>
            );
          })}
        </div>
      )}
      {visibleIssues.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {visibleIssues.map((issue, index) => {
            const locatorItems = issueLocatorItems(issue, t);
            const route = issueRoute(issue);
            return (
              <div
              key={`${issue.code}-${issue.reference_id ?? issue.task_id ?? index}`}
              className={`rounded-md border px-2 py-1.5 text-xs ${
                issue.acknowledged
                  ? "border-gray-700 bg-gray-950/60 text-gray-400"
                  : issue.severity === "error"
                    ? "border-red-400/20 bg-red-500/10 text-red-100"
                    : issue.severity === "warning"
                      ? "border-amber-400/20 bg-amber-500/10 text-amber-100"
                      : "border-gray-700 bg-gray-950/50 text-gray-400"
              }`}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-medium">{issue.title}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {issue.acknowledged && (
                    <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[11px] text-emerald-200">
                      {t("credit_reconciliation_acknowledged")}
                    </span>
                  )}
                  <span className="font-mono text-[11px] opacity-70">{issue.code}</span>
                </span>
              </div>
              <p className="mt-1 leading-5 opacity-80">{issue.detail}</p>
              {issue.suggestion && (
                <p className="mt-1 leading-5 opacity-70">
                  <span className="font-medium">{t("credit_reconciliation_suggestion")}：</span>
                  {issue.suggestion}
                </p>
              )}
              {issue.acknowledged && issue.acknowledgement_note && (
                <p className="mt-1 line-clamp-2 leading-5 opacity-70">
                  <span className="font-medium">{t("credit_reconciliation_ack_note")}：</span>
                  {issue.acknowledgement_note}
                </p>
              )}
              {locatorItems.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {locatorItems.map((item) => (
                    <span
                      key={`${item.label}-${item.value}`}
                      className="inline-flex max-w-full items-center gap-1 rounded border border-gray-700/70 bg-gray-950/60 px-1.5 py-0.5 text-[11px] opacity-80"
                    >
                      <span className="text-gray-500">{item.label}</span>
                      <span className="truncate font-mono">{item.value}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {route && (
                  <button
                    type="button"
                    onClick={() => onLocateIssue(issue)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1 text-[11px] text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {issueEpisode(issue)
                      ? t("credit_reconciliation_locator_open_episode")
                      : t("credit_reconciliation_locator_open_project")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={voidPromise(() => onCopyIssueLocator(issue))}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1 text-[11px] text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100"
                >
                  <Copy className="h-3 w-3" />
                  {t("credit_reconciliation_locator_copy")}
                </button>
              </div>
              {!issue.action && issue.severity !== "info" && !issue.acknowledged && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={voidPromise(() => onAcknowledgeIssue(issue))}
                    disabled={acknowledgingIssueKey !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1 text-[11px] text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {acknowledgingIssueKey === reconciliationIssueKey(issue)
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Check className="h-3 w-3" />}
                    {acknowledgingIssueKey === reconciliationIssueKey(issue)
                      ? t("credit_reconciliation_acknowledging")
                      : t("credit_reconciliation_acknowledge")}
                  </button>
                </div>
              )}
              {issue.acknowledged && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={voidPromise(() => onReopenIssue(issue))}
                    disabled={reopeningIssueKey !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1 text-[11px] text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {reopeningIssueKey === reconciliationIssueKey(issue)
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RotateCcw className="h-3 w-3" />}
                    {reopeningIssueKey === reconciliationIssueKey(issue)
                      ? t("credit_reconciliation_reopening")
                      : t("credit_reconciliation_reopen")}
                  </button>
                </div>
              )}
              </div>
            );
          })}
        </div>
      ) : issues.length > 0 && (
        <p className="mt-2 rounded-md border border-dashed border-gray-800 px-2 py-2 text-xs text-gray-600">
          {t("credit_reconciliation_filter_empty")}
        </p>
      )}
      <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-gray-300">{t("credit_reconciliation_audit_title")}</p>
          <span className="text-[11px] text-gray-600">{t("credit_reconciliation_audit_count", { count: audits.length })}</span>
        </div>
        <div className="mt-2 space-y-1.5">
          {audits.slice(0, 3).map((audit) => (
            <div key={audit.id} className="rounded-md border border-gray-800 bg-gray-950 px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-gray-300">{reconciliationAuditTitle(audit, t)}</span>
                <span className="shrink-0 text-[11px] text-gray-600">{formatLedgerTime(audit.created_at)}</span>
              </div>
              {audit.note && <p className="mt-1 line-clamp-2 text-gray-500">{audit.note}</p>}
            </div>
          ))}
          {audits.length === 0 && (
            <p className="rounded-md border border-dashed border-gray-800 px-2 py-2 text-xs text-gray-600">
              {t("credit_reconciliation_audit_empty")}
            </p>
          )}
        </div>
        <div className="mt-2 flex items-start gap-2">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={1000}
            rows={2}
            placeholder={t("credit_reconciliation_note_placeholder")}
            className="min-h-16 flex-1 resize-none rounded-md border border-gray-800 bg-gray-950 px-2 py-1.5 text-xs text-gray-200 outline-none transition-colors placeholder:text-gray-700 focus:border-indigo-400/50"
          />
          <button
            type="button"
            onClick={voidPromise(async () => {
              await onAddNote(trimmedNote);
              setNote("");
            })}
            disabled={!trimmedNote || savingNote}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-gray-700 px-2 text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingNote ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            {t("credit_reconciliation_note_save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreditLedgerPanel({
  balance,
  reconciliation,
  audits,
  loading,
  error,
  onRefresh,
  fixingAction,
  acknowledgingIssueKey,
  reopeningIssueKey,
  savingNote,
  onRunReconciliationAction,
  onAcknowledgeReconciliationIssue,
  onReopenReconciliationIssue,
  onLocateReconciliationIssue,
  onCopyReconciliationIssueLocator,
  onCopyReconciliationReport,
  onExportReconciliationCsv,
  onAddReconciliationNote,
}: {
  balance: CreditBalanceResponse | null;
  reconciliation: CreditReconciliationResponse | null;
  audits: CreditReconciliationAudit[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  fixingAction: CreditReconciliationAction | null;
  acknowledgingIssueKey: string | null;
  reopeningIssueKey: string | null;
  savingNote: boolean;
  onRunReconciliationAction: (action: CreditReconciliationAction) => Promise<void>;
  onAcknowledgeReconciliationIssue: (issue: CreditReconciliationIssue) => Promise<void>;
  onReopenReconciliationIssue: (issue: CreditReconciliationIssue) => Promise<void>;
  onLocateReconciliationIssue: (issue: CreditReconciliationIssue) => void;
  onCopyReconciliationIssueLocator: (issue: CreditReconciliationIssue) => Promise<void>;
  onCopyReconciliationReport: () => Promise<void>;
  onExportReconciliationCsv: () => void;
  onAddReconciliationNote: (note: string) => Promise<void>;
}) {
  const { t } = useTranslation("dashboard");
  const entries = balance?.entries ?? [];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 px-3 py-3 text-xs">
        <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
          <p className="text-gray-600">{t("credit_current_balance")}</p>
          <p className="mt-1 font-mono text-sm text-gray-100">
            {formatCreditNumber(balance?.balance)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
          <p className="text-gray-600">{t("task_center_credit_available")}</p>
          <p className="mt-1 font-mono text-sm text-emerald-300">
            {formatCreditNumber(balance?.available_balance)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
          <p className="text-gray-600">{t("task_center_credit_reserved")}</p>
          <p className="mt-1 font-mono text-sm text-amber-300">
            {formatCreditNumber(balance?.reserved_generation_credits)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
          <p className="text-gray-600">{t("task_center_credit_pending")}</p>
          <p className="mt-1 font-mono text-sm text-indigo-300">
            {formatCreditNumber(balance?.pending_purchase_credits)}
          </p>
        </div>
      </div>

      <CreditReconciliationPanel
        reconciliation={reconciliation}
        audits={audits}
        loading={loading}
        fixingAction={fixingAction}
        acknowledgingIssueKey={acknowledgingIssueKey}
        reopeningIssueKey={reopeningIssueKey}
        savingNote={savingNote}
        onRunAction={onRunReconciliationAction}
        onAcknowledgeIssue={onAcknowledgeReconciliationIssue}
        onReopenIssue={onReopenReconciliationIssue}
        onLocateIssue={onLocateReconciliationIssue}
        onCopyIssueLocator={onCopyReconciliationIssueLocator}
        onCopyReport={onCopyReconciliationReport}
        onExportCsv={onExportReconciliationCsv}
        onAddNote={onAddReconciliationNote}
      />

      <div className="flex items-center justify-between border-t border-gray-800 px-3 py-2">
        <div>
          <p className="text-xs font-semibold text-gray-300">{t("credit_recent_entries")}</p>
          <p className="text-[11px] text-gray-600">{t("task_center_credit_entries_hint")}</p>
        </div>
        <button
          type="button"
          onClick={voidPromise(onRefresh)}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          {t("refresh_credit_balance")}
        </button>
      </div>

      {error && (
        <p className="mx-3 mb-2 rounded-md border border-red-400/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-100">
          {t("credit_entries_load_failed", { message: error })}
        </p>
      )}
      {!error && loading && !balance && (
        <p className="px-3 py-4 text-xs text-gray-600">{t("loading_credit_entries")}</p>
      )}
      {!error && !loading && entries.length === 0 && (
        <p className="px-3 py-4 text-xs text-gray-600">{t("credit_entries_empty")}</p>
      )}
      {entries.slice(0, 12).map((entry) => (
        <CreditLedgerRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskHud — 弹出面板，实时展示任务队列状态
// ---------------------------------------------------------------------------

export function TaskHud({
  anchorRef,
  defaultTab = "tasks",
}: {
  anchorRef: RefObject<HTMLElement | null>;
  defaultTab?: TaskHudTab;
}) {
  const { t } = useTranslation("dashboard");
  const [, setLocation] = useLocation();
  const taskHudOpen = useAppStore((s) => s.taskHudOpen);
  const setTaskHudOpen = useAppStore((s) => s.setTaskHudOpen);
  const taskHudFocusTarget = useAppStore((s) => s.taskHudFocusTarget);
  const clearTaskHudFocusTarget = useAppStore((s) => s.clearTaskHudFocusTarget);
  const triggerScrollTo = useAppStore((s) => s.triggerScrollTo);
  const invalidateCreditReconciliation = useAppStore((s) => s.invalidateCreditReconciliation);
  const currentProjectName = useProjectsStore((s) => s.currentProjectName);
  const { tasks, stats, upsertTask } = useTasksStore();
  const [activeTab, setActiveTab] = useState<TaskHudTab>("tasks");
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TaskTypeFilter>("all");
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
  const [currentProjectOnly, setCurrentProjectOnly] = useState(false);
  const [creditBalance, setCreditBalance] = useState<CreditBalanceResponse | null>(null);
  const [creditReconciliation, setCreditReconciliation] = useState<CreditReconciliationResponse | null>(null);
  const [creditReconciliationAudits, setCreditReconciliationAudits] = useState<CreditReconciliationAudit[]>([]);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [fixingReconciliationAction, setFixingReconciliationAction] = useState<CreditReconciliationAction | null>(null);
  const [acknowledgingReconciliationIssueKey, setAcknowledgingReconciliationIssueKey] = useState<string | null>(null);
  const [reopeningReconciliationIssueKey, setReopeningReconciliationIssueKey] = useState<string | null>(null);
  const [savingReconciliationNote, setSavingReconciliationNote] = useState(false);

  const [cancelConfirm, setCancelConfirm] = useState<{
    taskId?: string;
    preview?: { task: { task_id: string; task_type: string; resource_id: string }; cascaded: { task_id: string; task_type: string; resource_id: string }[] };
    taskIds?: string[];
    allCount?: number;
    projectName?: string;
  } | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [retryingTaskIds, setRetryingTaskIds] = useState<Set<string>>(() => new Set());
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const taskListRef = useRef<HTMLDivElement>(null);
  const focusFetchRequestRef = useRef<string | null>(null);

  const loadCredits = useCallback(async () => {
    setCreditLoading(true);
    setCreditError(null);
    try {
      const [balance, reconciliation, audits] = await Promise.all([
        API.getCreditBalance(),
        API.getCreditReconciliation(),
        API.getCreditReconciliationAudits(),
      ]);
      setCreditBalance(balance);
      setCreditReconciliation(reconciliation);
      setCreditReconciliationAudits(audits.audits);
    } catch (err) {
      setCreditError(errMsg(err));
    } finally {
      setCreditLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!taskHudOpen) return;
    setActiveTab(defaultTab);
    void loadCredits();
  }, [defaultTab, loadCredits, taskHudOpen]);

  useEffect(() => {
    if (!taskHudOpen || !taskHudFocusTarget) return;

    const targetTaskId = taskHudFocusTarget.task_id;
    setActiveTab("tasks");
    setStatusFilter("all");
    setTypeFilter("all");
    setTaskSearchQuery("");
    setCurrentProjectOnly(false);
    setHighlightedTaskId(targetTaskId);

    if (tasks.some((task) => task.task_id === targetTaskId)) return;
    if (focusFetchRequestRef.current === taskHudFocusTarget.request_id) return;

    focusFetchRequestRef.current = taskHudFocusTarget.request_id;
    let disposed = false;
    API.getTask(targetTaskId)
      .then((task) => {
        if (!disposed) {
          upsertTask(task);
        }
      })
      .catch(() => {
        if (disposed) return;
        useAppStore.getState().pushToast(
          t("task_center_focus_missing", { taskId: targetTaskId }),
          "warning",
        );
        clearTaskHudFocusTarget(taskHudFocusTarget.request_id);
        setHighlightedTaskId(null);
      });

    return () => {
      disposed = true;
    };
  }, [clearTaskHudFocusTarget, taskHudFocusTarget, taskHudOpen, tasks, t, upsertTask]);

  useEffect(() => {
    if (!taskHudOpen || activeTab !== "tasks" || !taskHudFocusTarget) return;

    const targetTaskId = taskHudFocusTarget.task_id;
    if (!tasks.some((task) => task.task_id === targetTaskId)) return;

    const timeout = window.setTimeout(() => {
      const row = Array.from(taskListRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])
        .find((element) => element.dataset.taskId === targetTaskId);
      row?.scrollIntoView?.({ block: "center" });
      clearTaskHudFocusTarget(taskHudFocusTarget.request_id);
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [activeTab, clearTaskHudFocusTarget, taskHudFocusTarget, taskHudOpen, tasks]);

  useEffect(() => {
    if (!highlightedTaskId) return;
    const timeout = window.setTimeout(() => setHighlightedTaskId(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [highlightedTaskId]);

  const handleRunReconciliationAction = useCallback(async (action: CreditReconciliationAction) => {
    setFixingReconciliationAction(action);
    try {
      const result = await API.runCreditReconciliationAction({ action });
      useAppStore.getState().pushToast(
        t("credit_reconciliation_fix_success", {
          count: result.fixed_count,
          skipped: result.skipped_count,
        }),
        "success",
      );
      await loadCredits();
      invalidateCreditReconciliation();
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_fix_failed", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setFixingReconciliationAction(null);
    }
  }, [invalidateCreditReconciliation, loadCredits, t]);

  const handleAddReconciliationNote = useCallback(async (note: string) => {
    setSavingReconciliationNote(true);
    try {
      await API.addCreditReconciliationNote({ note });
      useAppStore.getState().pushToast(t("credit_reconciliation_note_saved"), "success");
      await loadCredits();
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_note_failed", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setSavingReconciliationNote(false);
    }
  }, [loadCredits, t]);

  const handleAcknowledgeReconciliationIssue = useCallback(async (issue: CreditReconciliationIssue) => {
    const issueKey = reconciliationIssueKey(issue);
    setAcknowledgingReconciliationIssueKey(issueKey);
    try {
      await API.acknowledgeCreditReconciliationIssue({
        note: t("credit_reconciliation_ack_default_note", { title: issue.title }),
        issue_code: issue.code,
        reference_type: issue.reference_type ?? null,
        reference_id: issue.reference_id ?? null,
        project_name: issue.project_name ?? null,
        task_id: issue.task_id ?? null,
      });
      useAppStore.getState().pushToast(t("credit_reconciliation_ack_success"), "success");
      await loadCredits();
      invalidateCreditReconciliation();
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_ack_failed", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setAcknowledgingReconciliationIssueKey(null);
    }
  }, [invalidateCreditReconciliation, loadCredits, t]);

  const handleReopenReconciliationIssue = useCallback(async (issue: CreditReconciliationIssue) => {
    const issueKey = reconciliationIssueKey(issue);
    setReopeningReconciliationIssueKey(issueKey);
    try {
      await API.reopenCreditReconciliationIssue({
        note: t("credit_reconciliation_reopen_default_note", { title: issue.title }),
        issue_code: issue.code,
        reference_type: issue.reference_type ?? null,
        reference_id: issue.reference_id ?? null,
        project_name: issue.project_name ?? null,
        task_id: issue.task_id ?? null,
      });
      useAppStore.getState().pushToast(t("credit_reconciliation_reopen_success"), "success");
      await loadCredits();
      invalidateCreditReconciliation();
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_reopen_failed", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setReopeningReconciliationIssueKey(null);
    }
  }, [invalidateCreditReconciliation, loadCredits, t]);

  const handleLocateReconciliationIssue = useCallback((issue: CreditReconciliationIssue) => {
    const route = issueRoute(issue);
    if (!route) return;

    setTaskHudOpen(false);
    startTransition(() => {
      setLocation(route);
    });
    if (issue.resource_id && issueEpisode(issue)) {
      triggerScrollTo({
        type: /^E\d+U/i.test(issue.resource_id) ? "reference-unit" : "segment",
        id: issue.resource_id,
        route,
        highlight_style: "flash",
        expires_at: Date.now() + 3000,
      });
    }
  }, [setLocation, setTaskHudOpen, triggerScrollTo]);

  const handleCopyReconciliationIssueLocator = useCallback(async (issue: CreditReconciliationIssue) => {
    try {
      await copyText(issueLocatorText(issue));
      useAppStore.getState().pushToast(t("credit_reconciliation_locator_copied"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_locator_copy_failed", { message: errMsg(err) }),
        "error",
      );
    }
  }, [t]);

  const handleCopyReconciliationReport = useCallback(async () => {
    try {
      await copyText(renderReconciliationReport(creditReconciliation, creditReconciliationAudits, t));
      useAppStore.getState().pushToast(t("credit_reconciliation_report_copied"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_report_copy_failed", { message: errMsg(err) }),
        "error",
      );
    }
  }, [creditReconciliation, creditReconciliationAudits, t]);

  const handleCopyModelRuleAudit = useCallback(async (items: TaskModelRuleAuditItem[]) => {
    try {
      await copyText(renderTaskModelRuleAuditText(items, t));
      useAppStore.getState().pushToast(t("task_model_rule_audit_copied"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(
        t("task_model_rule_audit_copy_failed", { message: errMsg(err) }),
        "error",
      );
    }
  }, [t]);

  const handleExportReconciliationCsv = useCallback(() => {
    try {
      downloadTextFile(
        reconciliationReportFilename(),
        renderReconciliationCsv(creditReconciliation),
        "text/csv;charset=utf-8",
      );
      useAppStore.getState().pushToast(t("credit_reconciliation_report_exported"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(
        t("credit_reconciliation_report_export_failed", { message: errMsg(err) }),
        "error",
      );
    }
  }, [creditReconciliation, t]);

  const handleCancelSingle = useCallback(async (taskId: string) => {
    try {
      const preview = await API.cancelPreview(taskId);
      setCancelConfirm({ taskId, preview });
    } catch {
      // task no longer queued
    }
  }, []);

  const handleCancelAll = useCallback(async () => {
    const queuedTask = tasks.find((t) => t.status === "queued");
    if (!queuedTask) return;
    const projectName = queuedTask.project_name;
    try {
      const { queued_count } = await API.cancelAllPreview(projectName);
      setCancelConfirm({ allCount: queued_count, projectName });
    } catch {
      // no queued tasks
    }
  }, [tasks]);

  const handleCancelFilteredQueued = useCallback((queuedTasks: TaskItem[]) => {
    const taskIds = queuedTasks.map((task) => task.task_id);
    if (taskIds.length === 0) return;
    setCancelConfirm({ taskIds, allCount: taskIds.length });
  }, []);

  const confirmCancel = useCallback(async () => {
    if (!cancelConfirm) return;
    setCancelling(true);
    try {
      if (cancelConfirm.taskId) {
        await API.cancelTask(cancelConfirm.taskId);
      } else if (cancelConfirm.taskIds) {
        const results = await Promise.allSettled(
          cancelConfirm.taskIds.map((taskId) => API.cancelTask(taskId)),
        );
        const cancelled = results.filter((result) => result.status === "fulfilled").length;
        const failed = results.length - cancelled;
        useAppStore.getState().pushToast(
          t("task_batch_cancel_result", { cancelled, failed }),
          failed > 0 ? "warning" : "success",
        );
      } else if (cancelConfirm.projectName) {
        await API.cancelAllQueued(cancelConfirm.projectName);
      }
    } finally {
      setCancelling(false);
      setCancelConfirm(null);
    }
  }, [cancelConfirm, t]);

  const handleLocateTask = useCallback((task: TaskItem) => {
    const target = getTaskLocationTarget(task);
    if (!target) return;

    setTaskHudOpen(false);
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
  }, [setLocation, setTaskHudOpen, triggerScrollTo]);

  const handleOpenModelRule = useCallback((ruleTarget: string) => {
    if (!ruleTarget.trim()) return;
    setTaskHudOpen(false);
    startTransition(() => {
      setLocation(modelRuleSettingsRoute(ruleTarget));
    });
  }, [setLocation, setTaskHudOpen]);

  const handleRetryTask = useCallback(async (taskId: string) => {
    setRetryingTaskIds((prev) => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    try {
      const result = await API.retryTask(taskId);
      useAppStore.getState().pushToast(
        result.deduped ? t("task_retry_deduped") : t("task_retry_queued"),
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(
        t("task_retry_failed", { message: errMsg(err) }),
        "error",
      );
    } finally {
      setRetryingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }, [t]);

  const handleRetryFailedTasks = useCallback(async (failedTasks: TaskItem[]) => {
    const taskIds = failedTasks.map((task) => task.task_id);
    if (taskIds.length === 0 || bulkRetrying) return;

    setBulkRetrying(true);
    setRetryingTaskIds((prev) => {
      const next = new Set(prev);
      taskIds.forEach((taskId) => next.add(taskId));
      return next;
    });
    try {
      const results = await Promise.allSettled(taskIds.map((taskId) => API.retryTask(taskId)));
      const queued = results.filter((result) => result.status === "fulfilled" && !result.value.deduped).length;
      const deduped = results.filter((result) => result.status === "fulfilled" && result.value.deduped).length;
      const failed = results.length - queued - deduped;
      useAppStore.getState().pushToast(
        t("task_batch_retry_result", { queued, deduped, failed }),
        failed > 0 ? "warning" : "success",
      );
    } finally {
      setRetryingTaskIds((prev) => {
        const next = new Set(prev);
        taskIds.forEach((taskId) => next.delete(taskId));
        return next;
      });
      setBulkRetrying(false);
    }
  }, [bulkRetrying, t]);

  const handleCopyFailureReport = useCallback(async (failedTasks: TaskItem[]) => {
    try {
      await copyText(renderTaskFailureReport(failedTasks, t));
      useAppStore.getState().pushToast(t("task_failure_report_copied"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(
        t("task_failure_report_copy_failed", { message: errMsg(err) }),
        "error",
      );
    }
  }, [t]);

  useEscapeClose(() => setCancelConfirm(null), Boolean(cancelConfirm));

  const filteredTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          taskMatchesStatusFilter(task, statusFilter) &&
          taskMatchesTypeFilter(task, typeFilter) &&
          (!currentProjectOnly || !currentProjectName || task.project_name === currentProjectName) &&
          taskMatchesSearchQuery(task, taskSearchQuery),
      ),
    [currentProjectName, currentProjectOnly, statusFilter, taskSearchQuery, tasks, typeFilter],
  );
  const hasTaskFilters =
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    taskSearchQuery.trim().length > 0 ||
    currentProjectOnly;
  const filteredFailedTasks = useMemo(
    () => filteredTasks.filter((task) => task.status === "failed"),
    [filteredTasks],
  );
  const filteredQueuedTasks = useMemo(
    () => filteredTasks.filter((task) => task.status === "queued"),
    [filteredTasks],
  );
  const creditEntries = creditBalance?.entries ?? [];

  return (
    <Popover
      open={taskHudOpen}
      onClose={() => setTaskHudOpen(false)}
      anchorRef={anchorRef}
      sideOffset={4}
      width="w-[34rem] max-w-[calc(100vw-1rem)]"
      className="rounded-lg border border-gray-800 shadow-xl"
    >
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-3 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-100">
              <Activity className="h-4 w-4 text-indigo-300" />
              {t("task_center_title")}
            </p>
            <p className="mt-1 text-xs text-gray-600">{t("task_center_desc")}</p>
          </div>
          <div className="flex shrink-0 rounded-lg border border-gray-800 bg-gray-950 p-0.5">
            {(["tasks", "credits"] as const).map((tab) => {
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? "bg-indigo-500/20 text-indigo-100"
                      : "text-gray-500 hover:bg-gray-800 hover:text-gray-200"
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    {tab === "tasks" ? <Activity className="h-3 w-3" /> : <Coins className="h-3 w-3" />}
                    {t(tab === "tasks" ? "task_center_tab_tasks" : "task_center_tab_credits")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 统计栏 */}
          <div className="flex flex-wrap gap-3 border-b border-gray-800 px-3 py-2 text-xs text-gray-400">
            <span>
              {t("queued_label")}{" "}
              <strong className="text-gray-200">{stats.queued}</strong>
            </span>
            <span>
              {t("running_label")}{" "}
              <strong className="text-indigo-400">{stats.running}</strong>
            </span>
            <span>
              {t("completed_label")}{" "}
              <strong className="text-emerald-400">{stats.succeeded}</strong>
            </span>
            <span>
              {t("failed_label")}{" "}
              <strong className="text-red-400">{stats.failed}</strong>
            </span>
            {stats.cancelled > 0 && (
              <span>
                {t("cancelled_label")}{" "}
                <strong className="text-gray-400">{stats.cancelled}</strong>
              </span>
            )}
            {stats.queued > 0 && (
              <button
                onClick={voidPromise(handleCancelAll)}
                className="ml-auto text-xs text-gray-500 hover:text-red-400"
                aria-label={t("cancel_all_queued_aria")}
              >
                {t("cancel_all")}
              </button>
            )}
          </div>

          {activeTab === "tasks" ? (
            <>
              <div className="space-y-2 border-b border-gray-800 px-3 py-2">
                <label className="block min-w-0 text-xs text-gray-500">
                  <span className="mb-1 flex items-center gap-1">
                    <Search className="h-3 w-3" />
                    {t("task_center_search_filter")}
                  </span>
                  <input
                    value={taskSearchQuery}
                    onChange={(event) => setTaskSearchQuery(event.target.value)}
                    placeholder={t("task_center_search_placeholder")}
                    aria-label={t("task_center_search_filter")}
                    className="h-8 w-full rounded-md border border-gray-700 bg-gray-950 px-2 text-xs text-gray-200 outline-none transition-colors placeholder:text-gray-700 focus:border-indigo-400/50"
                  />
                </label>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <label className={`inline-flex min-w-0 items-center gap-2 text-xs ${
                    currentProjectName ? "text-gray-400" : "text-gray-700"
                  }`}>
                    <input
                      type="checkbox"
                      checked={currentProjectOnly}
                      disabled={!currentProjectName}
                      onChange={(event) => setCurrentProjectOnly(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-700 bg-gray-950 text-indigo-500 focus:ring-indigo-400"
                    />
                    <span className="truncate">
                      {t("task_center_current_project_only", { project: currentProjectName ?? "-" })}
                    </span>
                  </label>
                  {hasTaskFilters && (
                    <button
                      type="button"
                      onClick={() => {
                        setStatusFilter("all");
                        setTypeFilter("all");
                        setTaskSearchQuery("");
                        setCurrentProjectOnly(false);
                      }}
                      className="inline-flex h-7 items-center rounded-md border border-gray-800 px-2 text-[11px] text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200 focus-ring"
                    >
                      {t("task_center_clear_filters")}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="min-w-0 text-xs text-gray-500">
                    <span className="mb-1 flex items-center gap-1">
                      <ListFilter className="h-3 w-3" />
                      {t("task_center_status_filter")}
                    </span>
                    <select
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value as TaskStatusFilter)}
                      className="h-8 w-full rounded-md border border-gray-700 bg-gray-950 px-2 text-xs text-gray-200 focus-ring"
                    >
                      {TASK_STATUS_FILTERS.map((filter) => (
                        <option key={filter} value={filter}>
                          {t(`task_filter_status_${filter}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-0 text-xs text-gray-500">
                    <span className="mb-1 block">{t("task_center_type_filter")}</span>
                    <select
                      value={typeFilter}
                      onChange={(event) => setTypeFilter(event.target.value as TaskTypeFilter)}
                      className="h-8 w-full rounded-md border border-gray-700 bg-gray-950 px-2 text-xs text-gray-200 focus-ring"
                    >
                      {TASK_TYPE_FILTERS.map((filter) => (
                        <option key={filter} value={filter}>
                          {t(`task_filter_type_${filter}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <BatchTaskActionsPanel
                failedTasks={filteredFailedTasks}
                queuedTasks={filteredQueuedTasks}
                retrying={bulkRetrying}
                onRetryFailed={() => handleRetryFailedTasks(filteredFailedTasks)}
                onCopyFailureReport={() => handleCopyFailureReport(filteredFailedTasks)}
                onCancelQueued={() => handleCancelFilteredQueued(filteredQueuedTasks)}
              />

              <ModelRuleAuditPanel
                tasks={filteredTasks}
                onOpenModelRule={handleOpenModelRule}
                onCopyAudit={handleCopyModelRuleAudit}
              />

              <div ref={taskListRef} className="max-h-96 divide-y divide-gray-800/50 overflow-y-auto">
                <ChannelSection
                  title={t("task_center_filtered_tasks", { count: filteredTasks.length })}
                  icon={Activity}
                  tasks={filteredTasks}
                  highlightedTaskId={highlightedTaskId}
                  onCancel={voidPromise(handleCancelSingle)}
                  onLocate={handleLocateTask}
                  onOpenModelRule={handleOpenModelRule}
                  onRetry={voidPromise(handleRetryTask)}
                  retryingTaskIds={retryingTaskIds}
                  creditEntries={creditEntries}
                  recentLimit={40}
                  autoFadeCompleted={false}
                />
              </div>
            </>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <CreditLedgerPanel
                balance={creditBalance}
                reconciliation={creditReconciliation}
                audits={creditReconciliationAudits}
                loading={creditLoading}
                error={creditError}
                onRefresh={loadCredits}
                fixingAction={fixingReconciliationAction}
                acknowledgingIssueKey={acknowledgingReconciliationIssueKey}
                reopeningIssueKey={reopeningReconciliationIssueKey}
                savingNote={savingReconciliationNote}
                onRunReconciliationAction={handleRunReconciliationAction}
                onAcknowledgeReconciliationIssue={handleAcknowledgeReconciliationIssue}
                onReopenReconciliationIssue={handleReopenReconciliationIssue}
                onLocateReconciliationIssue={handleLocateReconciliationIssue}
                onCopyReconciliationIssueLocator={handleCopyReconciliationIssueLocator}
                onCopyReconciliationReport={handleCopyReconciliationReport}
                onExportReconciliationCsv={handleExportReconciliationCsv}
                onAddReconciliationNote={handleAddReconciliationNote}
              />
            </div>
          )}

          {/* 取消确认面板 */}
          {cancelConfirm && (
            <div className="border-t border-gray-800 px-3 py-2" role="alertdialog" aria-label={t("cancel_confirm_aria")}>
              <p className="text-xs text-gray-300">
                {cancelConfirm.preview
                  ? cancelConfirm.preview.cascaded.length > 0
                    ? t("cancel_cascade_msg", { count: cancelConfirm.preview.cascaded.length })
                    : t("cancel_single_confirm")
                  : cancelConfirm.taskIds
                    ? t("cancel_filtered_confirm", { count: cancelConfirm.taskIds.length })
                    : t("cancel_all_confirm", { count: cancelConfirm.allCount })}
              </p>
              {cancelConfirm.preview && cancelConfirm.preview.cascaded.length > 0 && (
                <ul className="mt-1 max-h-20 overflow-y-auto text-xs text-gray-500">
                  {cancelConfirm.preview.cascaded.map((t) => (
                    <li key={t.task_id}>
                      {t.task_type} / {t.resource_id}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={voidPromise(confirmCancel)}
                  disabled={cancelling}
                  className="rounded bg-red-600/80 px-2 py-0.5 text-xs text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {cancelling ? t("cancelling") : t("confirm_cancel")}
                </button>
                <button
                  onClick={() => setCancelConfirm(null)}
                  className="rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-700"
                >
                  {t("go_back")}
                </button>
              </div>
            </div>
          )}
      </motion.div>
    </Popover>
  );
}
