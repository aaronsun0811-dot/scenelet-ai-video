import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderTree, Loader2, RefreshCw, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import type { ProjectNamespaceMigrationResponse } from "@/types";
import { useAppStore } from "@/stores/app-store";
import { errMsg } from "@/utils/async";

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-2 text-xl font-semibold text-gray-100">{value}</div>
    </div>
  );
}

export function ProjectNamespaceMigrationSection() {
  const { t } = useTranslation(["dashboard"]);
  const [preview, setPreview] = useState<ProjectNamespaceMigrationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [migrating, setMigrating] = useState(false);

  const candidateCount = preview?.candidates.length ?? 0;
  const conflictCount = preview?.conflicts.length ?? 0;
  const errorCount = preview?.errors.length ?? 0;
  const canMigrate = candidateCount > 0 && !migrating;

  const visibleCandidates = useMemo(
    () => preview?.candidates.slice(0, 8) ?? [],
    [preview?.candidates],
  );

  const loadPreview = async () => {
    setLoading(true);
    try {
      setPreview(await API.getProjectNamespaceMigrationPreview());
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:namespace_migration_preview_failed")}${errMsg(err)}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runMigration = async () => {
    setMigrating(true);
    try {
      const result = await API.runProjectNamespaceMigration();
      setPreview(result);
      useAppStore.getState().pushToast(
        t("dashboard:namespace_migration_success", { count: result.migrated.length }),
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:namespace_migration_failed")}${errMsg(err)}`, "error");
    } finally {
      setMigrating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-100">{t("dashboard:namespace_migration_title")}</h2>
          <p className="mt-1 text-sm text-gray-500">{t("dashboard:namespace_migration_desc")}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadPreview()}
          disabled={loading || migrating}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 hover:border-gray-700 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("dashboard:namespace_migration_refresh")}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <CountTile label={t("dashboard:namespace_migration_candidates")} value={candidateCount} />
        <CountTile label={t("dashboard:namespace_migration_conflicts")} value={conflictCount} />
        <CountTile label={t("dashboard:namespace_migration_errors")} value={errorCount} />
        <CountTile label={t("dashboard:namespace_migration_skipped")} value={preview?.skipped.length ?? 0} />
      </div>

      {preview && candidateCount === 0 && (
        <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            {t("dashboard:namespace_migration_none")}
          </div>
        </div>
      )}

      {conflictCount > 0 && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            {t("dashboard:namespace_migration_conflict_hint", { count: conflictCount })}
          </div>
        </div>
      )}

      {visibleCandidates.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900">
          <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-3 text-sm font-medium text-gray-200">
            <FolderTree className="h-4 w-4" />
            {t("dashboard:namespace_migration_candidate_list")}
          </div>
          <div className="divide-y divide-gray-800">
            {visibleCandidates.map((item) => (
              <div key={`${item.owner_user_id}:${item.project_name}`} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-100">{item.project_name}</div>
                    <div className="mt-1 truncate text-xs text-gray-500">{item.owner_user_id}</div>
                  </div>
                  <div className="shrink-0 rounded bg-gray-800 px-2 py-1 text-xs text-gray-400">
                    {item.reason ?? t("dashboard:namespace_migration_ready")}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {(preview?.candidates.length ?? 0) > visibleCandidates.length && (
            <div className="border-t border-gray-800 px-4 py-3 text-xs text-gray-500">
              {t("dashboard:namespace_migration_more", {
                count: (preview?.candidates.length ?? 0) - visibleCandidates.length,
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void runMigration()}
          disabled={!canMigrate}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
        >
          {migrating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {t("dashboard:namespace_migration_run")}
        </button>
      </div>
    </div>
  );
}
