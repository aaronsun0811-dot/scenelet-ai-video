import { Activity, AlertTriangle, CheckCircle2, FileJson, FileText, Loader2, MapPinned } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArchiveDiagnostic, ProjectArchiveDeliveryReport, ProjectArchiveModelRuleAuditManifest } from "@/types";
import {
  downloadDeliveryReportJson,
  downloadDeliveryReportMarkdown,
} from "@/utils/project-export";

interface DiagnosticsSection {
  key: string;
  title: string;
  tone: string;
  items: ArchiveDiagnostic[];
}

interface ArchiveDiagnosticsDialogProps {
  title: string;
  description: string;
  sections: DiagnosticsSection[];
  deliveryReport?: ProjectArchiveDeliveryReport | null;
  modelRuleAudit?: ProjectArchiveModelRuleAuditManifest | null;
  deliveryReportMode?: "alerts" | "all";
  deliveryReportFilePrefix?: string | null;
  showCleanDeliveryReport?: boolean;
  confirmLabel?: string;
  confirmBusy?: boolean;
  secondaryLabel?: string;
  onClose: () => void;
  onConfirm?: () => void;
  onSecondary?: () => void;
  onOpenTask?: (taskId: string) => void;
}

function hasDeliveryReportAlerts(report: ProjectArchiveDeliveryReport | null | undefined): boolean {
  return Boolean(report && (report.totals.blocking_issues > 0 || report.totals.warnings > 0));
}

function DeliveryReportStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-black/15 px-3 py-2">
      <p className="text-xs text-current/65">{label}</p>
      <p className="mt-1 font-mono text-sm text-current">{value}</p>
    </div>
  );
}

function formatCounterSummary(
  counts: Record<string, number>,
  labeler: (value: string) => string,
): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => Number.isFinite(count))
    .map(([key, count]) => `${labeler(key)} ${count}`);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function DeliveryReportPanel({
  report,
  modelRuleAudit: modelRuleAuditManifest,
  mode = "alerts",
  filePrefix,
  onOpenTask,
}: {
  report: ProjectArchiveDeliveryReport;
  modelRuleAudit?: ProjectArchiveModelRuleAuditManifest | null;
  mode?: "alerts" | "all";
  filePrefix?: string | null;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const hasBlockingIssues = report.totals.blocking_issues > 0;
  const issueEpisodes = report.episodes.filter((episode) => episode.blocking_issues.length > 0 || episode.warnings.length > 0);
  const visibleEpisodes = mode === "all" ? report.episodes : issueEpisodes.slice(0, 5);
  const hiddenEpisodeCount = mode === "all" ? 0 : Math.max(issueEpisodes.length - visibleEpisodes.length, 0);
  const travelRoute = report.travel_route;
  const modelRuleAudit = modelRuleAuditManifest ?? report.model_rule_audit;
  const visibleModelRuleTasks = modelRuleAuditManifest?.items.slice(0, 4) ?? [];
  const missingRouteNodes = travelRoute?.nodes.filter((node) => !node.covered) ?? [];
  const modelRuleModeLabel = (value: string) => {
    if (["default", "prompt", "github_skill", "uploaded_skill"].includes(value)) {
      return t(`model_rule_mode_${value}` as Parameters<typeof t>[0]);
    }
    return value || "-";
  };
  const modelRuleMediaLabel = (value: string) => {
    if (value === "image") return t("image_generation");
    if (value === "video") return t("video_generation");
    if (value === "text") return t("text_generation");
    return value || "-";
  };
  const statusLabel = report.status === "ready"
    ? t("delivery_report_status_ready")
    : report.status === "ready_with_warnings"
      ? t("delivery_report_status_ready_with_warnings")
      : t("delivery_report_status_needs_work");
  const tone = hasBlockingIssues
    ? "border-amber-400/25 bg-amber-500/10 text-amber-100"
    : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100";

  return (
    <section className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {hasBlockingIssues ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{t("delivery_report_title")}</h3>
            <p className="mt-1 text-sm text-current/75">
              {t("delivery_report_status_line", { status: statusLabel })}
            </p>
            <p className="mt-1 text-xs text-current/60">
              {t("delivery_report_generated_at", { time: report.generated_at ?? "-" })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => downloadDeliveryReportMarkdown(report, filePrefix)}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-current/20 px-2 text-xs font-medium text-current/80 transition-colors hover:bg-black/15 hover:text-current"
          >
            <FileText className="h-3.5 w-3.5" />
            {t("delivery_report_download_markdown")}
          </button>
          <button
            type="button"
            onClick={() => downloadDeliveryReportJson(report, filePrefix)}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-current/20 px-2 text-xs font-medium text-current/80 transition-colors hover:bg-black/15 hover:text-current"
          >
            <FileJson className="h-3.5 w-3.5" />
            {t("delivery_report_download_json")}
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <DeliveryReportStat
          label={t("delivery_report_stat_episodes")}
          value={`${report.totals.ready_episodes} / ${report.totals.episodes}`}
        />
        <DeliveryReportStat
          label={t("delivery_report_stat_storyboards")}
          value={`${report.totals.storyboards_ready} / ${report.totals.storyboards_total}`}
        />
        <DeliveryReportStat
          label={t("delivery_report_stat_videos")}
          value={`${report.totals.videos_ready} / ${report.totals.videos_total}`}
        />
        <DeliveryReportStat
          label={t("delivery_report_stat_issues")}
          value={`${report.totals.blocking_issues} / ${report.totals.warnings}`}
        />
      </div>

      {travelRoute && (
        <div className="mt-3 rounded-lg bg-black/15 px-3 py-3">
          <div className="flex items-start gap-2">
            <MapPinned className="mt-0.5 h-4 w-4 shrink-0 text-current/75" />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold">{t("delivery_report_travel_route_title")}</h4>
              <p className="mt-1 text-xs leading-5 text-current/70">
                {travelRoute.summary || t("delivery_report_travel_route_no_summary")}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <DeliveryReportStat
              label={t("delivery_report_travel_route_status")}
              value={travelRoute.route_ready
                ? t("delivery_report_travel_route_ready")
                : t("delivery_report_travel_route_needs_check")}
            />
            <DeliveryReportStat
              label={t("delivery_report_travel_route_coverage")}
              value={`${travelRoute.nodes_covered} / ${travelRoute.nodes_total}`}
            />
            <DeliveryReportStat
              label={t("delivery_report_travel_route_references")}
              value={`${travelRoute.usable_reference_images_count} / ${travelRoute.reference_images_count}`}
            />
          </div>
          <p className="mt-2 text-xs text-current/65">
            {t("delivery_report_travel_route_origin_destination", {
              origin: travelRoute.origin ?? "-",
              destination: travelRoute.destination ?? "-",
            })}
          </p>
          {missingRouteNodes.length > 0 && (
            <p className="mt-1 text-xs text-current/65">
              {t("delivery_report_travel_route_missing_nodes", {
                nodes: missingRouteNodes.map((node) => node.label || node.id).slice(0, 4).join(", "),
              })}
            </p>
          )}
          <div className="mt-3 rounded-md border border-current/15 bg-black/10 px-3 py-2 text-xs leading-5 text-current/70">
            <p className="font-medium text-current">{t("delivery_report_travel_route_asset_manifest_title")}</p>
            <p className="mt-1">{t("delivery_report_travel_route_asset_manifest_desc")}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
              <span className="rounded bg-black/20 px-2 py-1">output/scenelet-travel-route-assets.html</span>
              <span className="rounded bg-black/20 px-2 py-1">output/scenelet-travel-route-assets.json</span>
            </div>
          </div>
        </div>
      )}

      {modelRuleAudit && (
        <div className="mt-3 rounded-lg bg-black/15 px-3 py-3">
          <div className="flex items-start gap-2">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-current/75" />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold">{t("delivery_report_model_rule_audit_title")}</h4>
              <p className="mt-1 text-xs leading-5 text-current/70">
                {t("delivery_report_model_rule_audit_desc")}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <DeliveryReportStat
              label={t("delivery_report_model_rule_audit_total")}
              value={modelRuleAudit.total}
            />
            <DeliveryReportStat
              label={t("delivery_report_model_rule_audit_modes")}
              value={formatCounterSummary(modelRuleAudit.by_mode, modelRuleModeLabel)}
            />
            <DeliveryReportStat
              label={t("delivery_report_model_rule_audit_media")}
              value={formatCounterSummary(modelRuleAudit.by_media_type, modelRuleMediaLabel)}
            />
          </div>
          {modelRuleAudit.artifact_files.length > 0 && (
            <div className="mt-3 rounded-md border border-current/15 bg-black/10 px-3 py-2 text-xs leading-5 text-current/70">
              <p className="font-medium text-current">{t("delivery_report_model_rule_audit_files")}</p>
              <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
                {modelRuleAudit.artifact_files.map((file) => (
                  <span key={file} className="rounded bg-black/20 px-2 py-1">{file}</span>
                ))}
              </div>
            </div>
          )}
          {visibleModelRuleTasks.length > 0 && onOpenTask && (
            <div className="mt-3 rounded-md border border-current/15 bg-black/10 px-3 py-2 text-xs leading-5 text-current/70">
              <p className="font-medium text-current">{t("delivery_report_model_rule_audit_recent_tasks")}</p>
              <div className="mt-2 space-y-1.5">
                {visibleModelRuleTasks.map((item) => (
                  <div key={item.task_id} className="flex min-w-0 flex-wrap items-center gap-2 rounded bg-black/15 px-2 py-1.5">
                    <span className="max-w-[10rem] truncate font-mono text-[11px] text-current" title={item.resource_id || item.task_id}>
                      {item.resource_id || item.task_id}
                    </span>
                    <span className="rounded border border-current/15 px-1.5 py-0.5 text-[11px] text-current/70">
                      {item.rule.target_label || [item.rule.provider_id, item.rule.model_id].filter(Boolean).join(" / ") || "-"}
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenTask(item.task_id)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-current/20 px-2 py-0.5 text-[11px] font-medium text-current/80 transition-colors hover:bg-black/15 hover:text-current"
                    >
                      <Activity className="h-3 w-3" />
                      {t("model_rule_audit_preview_open_task")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {visibleEpisodes.length > 0 && (
        <div className="mt-3 space-y-2">
          {visibleEpisodes.map((episode, index) => (
            <div
              key={`${episode.episode ?? index}-${episode.script_file}`}
              className="rounded-lg bg-black/15 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-current/60">
                  {episode.episode === null ? "E?" : `E${episode.episode}`}
                </span>
                <span className="min-w-0 truncate font-medium">{episode.title}</span>
              </div>
              <p className="mt-1 text-xs text-current/70">
                {t("delivery_report_episode_detail", {
                  storyboards: `${episode.storyboards.ready}/${episode.storyboards.total}`,
                  videos: `${episode.videos.ready}/${episode.videos.total}`,
                })}
              </p>
              {episode.blocking_issues.length === 0 && episode.warnings.length === 0 ? (
                <p className="mt-1.5 text-xs text-current/70">{t("delivery_report_episode_ready")}</p>
              ) : (
                <ul className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                  {[...episode.blocking_issues, ...episode.warnings].map((issue) => (
                    <li
                      key={`${issue.code}-${issue.message}`}
                      className="rounded-md bg-black/20 px-2 py-1 text-current/80"
                    >
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {hiddenEpisodeCount > 0 && (
            <p className="text-sm text-current/70">
              {t("delivery_report_more_episodes", { count: hiddenEpisodeCount })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function ArchiveDiagnosticsDialog({
  title,
  description,
  sections,
  deliveryReport,
  modelRuleAudit,
  deliveryReportMode = "alerts",
  deliveryReportFilePrefix,
  showCleanDeliveryReport = false,
  confirmLabel,
  confirmBusy = false,
  secondaryLabel,
  onClose,
  onConfirm,
  onSecondary,
  onOpenTask,
}: ArchiveDiagnosticsDialogProps) {
  const { t } = useTranslation(["dashboard", "common"]);
  const visibleSections = sections.filter((s) => s.items.length > 0);
  const showDeliveryReport = Boolean(
    deliveryReport &&
    (showCleanDeliveryReport || deliveryReportMode === "all" || hasDeliveryReportAlerts(deliveryReport)),
  );

  if (visibleSections.length === 0 && !showDeliveryReport) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
      <div className="w-full max-w-2xl rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl shadow-black/40">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-amber-400/10 p-2 text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
            </div>
            <p className="text-sm leading-6 text-gray-400">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={confirmBusy}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
          >
            {t("common:close")}
          </button>
        </div>

        <div className="mt-5 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {showDeliveryReport && deliveryReport && (
            <DeliveryReportPanel
              report={deliveryReport}
              modelRuleAudit={modelRuleAudit}
              mode={deliveryReportMode}
              filePrefix={deliveryReportFilePrefix}
              onOpenTask={onOpenTask}
            />
          )}
          {visibleSections.map((section) => (
            <section key={section.key} className={`rounded-xl border p-4 ${section.tone}`}>
              <h3 className="text-sm font-semibold">{section.title}</h3>
              <ul className="mt-3 space-y-2 text-sm leading-6">
                {section.items.map((item, index) => (
                  <li
                    key={`${section.key}-${item.code}-${item.location ?? index}`}
                    className="rounded-lg bg-black/15 px-3 py-2"
                  >
                    <p>{item.message}</p>
                    {item.location && (
                      <p className="mt-1 font-mono text-xs text-current/70">{item.location}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {(onConfirm || onSecondary) && (
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={confirmBusy}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-700 px-4 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("common:cancel")}
            </button>
            {onSecondary && (
              <button
                type="button"
                onClick={onSecondary}
                disabled={confirmBusy}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-4 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {secondaryLabel ?? t("project_export_gate_go_fix")}
              </button>
            )}
            {onConfirm && (
              <button
                type="button"
                onClick={onConfirm}
                disabled={confirmBusy}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-4 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {confirmBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmLabel ?? t("project_export_gate_force_export")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
