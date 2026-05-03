import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProjectDeliveryEpisodeCheck, ProjectDeliverySummary } from "@/utils/project-delivery";

function buildIssueLabels(
  check: ProjectDeliveryEpisodeCheck,
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  return [
    !check.scriptReady ? t("project_export_gate_missing_script") : null,
    check.storyboardTotal > check.storyboardReady
      ? t("project_export_gate_missing_storyboards", {
        ready: check.storyboardReady,
        total: check.storyboardTotal,
      })
      : null,
    check.videoTotal > check.videoReady
      ? t("project_export_gate_missing_videos", {
        ready: check.videoReady,
        total: check.videoTotal,
      })
      : null,
    check.failedTasks > 0
      ? t("project_export_gate_failed_tasks", { count: check.failedTasks })
      : null,
    check.missingThumbnails > 0
      ? t("project_export_gate_missing_thumbnails", { count: check.missingThumbnails })
      : null,
  ].filter((label): label is string => Boolean(label));
}

export function ProjectPreExportDialog({
  summary,
  busy,
  handleNextLabel,
  onClose,
  onHandleNext,
  onConfirmExport,
}: {
  summary: ProjectDeliverySummary;
  busy: boolean;
  handleNextLabel?: string;
  onClose: () => void;
  onHandleNext?: () => void;
  onConfirmExport: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const hasBlockingIssues = summary.blockingIssues > 0;
  const affectedEpisodes = summary.episodes.filter(
    (check) => check.blockingIssues > 0 || check.missingThumbnails > 0,
  );
  const visibleEpisodes = affectedEpisodes.slice(0, 6);
  const hiddenEpisodeCount = Math.max(affectedEpisodes.length - visibleEpisodes.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-2xl rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl shadow-black/40">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-3">
              <div className={`rounded-full p-2 ${
                hasBlockingIssues ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300"
              }`}>
                {hasBlockingIssues ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <CheckCircle2 className="h-5 w-5" />
                )}
              </div>
              <h2 className="text-lg font-semibold text-gray-100">{t("project_export_gate_title")}</h2>
            </div>
            <p className="text-sm leading-6 text-gray-400">
              {hasBlockingIssues
                ? t("project_export_gate_desc_blocking", { count: summary.blockingIssues })
                : t("project_export_gate_desc_warnings", { count: summary.missingThumbnails })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t("project_export_gate_cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <div className={`rounded-xl border p-3 ${
            hasBlockingIssues ? "border-amber-400/25 bg-amber-500/10" : "border-emerald-400/25 bg-emerald-500/10"
          }`}>
            <p className="text-xs text-gray-500">{t("project_export_gate_blocking_count")}</p>
            <p className="mt-1 font-mono text-lg text-gray-100">{summary.blockingIssues}</p>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-950/60 p-3">
            <p className="text-xs text-gray-500">{t("project_export_gate_warning_count")}</p>
            <p className="mt-1 font-mono text-lg text-gray-100">{summary.missingThumbnails}</p>
          </div>
        </div>

        <div className="mt-4 max-h-[44vh] space-y-2 overflow-y-auto pr-1">
          {visibleEpisodes.map((check) => (
            <section
              key={check.episode.episode}
              className="rounded-xl border border-gray-800 bg-gray-950/55 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-gray-500">E{check.episode.episode}</span>
                <h3 className="min-w-0 truncate text-sm font-medium text-gray-100">{check.episode.title}</h3>
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {buildIssueLabels(check, t).map((label) => (
                  <li
                    key={label}
                    className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-300"
                  >
                    {label}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {hiddenEpisodeCount > 0 && (
            <p className="rounded-xl border border-gray-800 bg-gray-950/55 px-3 py-2 text-sm text-gray-400">
              {t("project_export_gate_more_episodes", { count: hiddenEpisodeCount })}
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-700 px-4 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("project_export_gate_cancel")}
          </button>
          {hasBlockingIssues && onHandleNext && (
            <button
              type="button"
              onClick={onHandleNext}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-4 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {handleNextLabel ?? t("project_export_gate_handle_next")}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirmExport}
            disabled={busy}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              hasBlockingIssues
                ? "bg-amber-600 hover:bg-amber-500"
                : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {hasBlockingIssues ? t("project_export_gate_force_export") : t("project_export_gate_confirm_export")}
          </button>
        </div>
      </div>
    </div>
  );
}
