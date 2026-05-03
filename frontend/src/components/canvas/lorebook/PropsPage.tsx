import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GalleryToolbar } from "./GalleryToolbar";
import { PropCard } from "./PropCard";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { AssetPickerModal } from "@/components/assets/AssetPickerModal";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { errMsg } from "@/utils/async";
import type { Prop } from "@/types";

interface Props {
  projectName: string;
  props: Record<string, Prop>;
  onUpdateProp: (name: string, updates: Partial<Prop>) => void;
  onGenerateProps?: () => void;
  onGenerateProp: (name: string) => void;
  onGenerateMissingProps?: () => void;
  onAddProp: (name: string, description: string) => Promise<void>;
  onRestorePropVersion?: () => Promise<void> | void;
  onRefreshProject?: () => Promise<void> | void;
  generatingProps?: boolean;
  generatingPropNames?: Set<string>;
}

export function PropsPage({
  projectName,
  props,
  onUpdateProp,
  onGenerateProps,
  onGenerateProp,
  onGenerateMissingProps,
  onAddProp,
  onRestorePropVersion,
  onRefreshProject,
  generatingProps,
  generatingPropNames,
}: Props) {
  const { t } = useTranslation(["dashboard", "assets"]);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  useScrollTarget("prop");

  const entries = Object.entries(props);
  const missingDesignEntries = entries.filter(([, prop]) => !prop.prop_sheet);
  const submittableMissingDesignCount = missingDesignEntries.filter(
    ([name]) => !generatingPropNames?.has(name),
  ).length;
  const missingDesignCount = submittableMissingDesignCount || missingDesignEntries.length;

  const handleImport = async (ids: string[]) => {
    try {
      await API.applyAssetsToProject({
        asset_ids: ids,
        target_project: projectName,
        conflict_policy: "skip",
      });
      useAppStore.getState().pushToast(t("assets:import_count", { count: ids.length }), "success");
      await onRefreshProject?.();
    } catch (err) {
      useAppStore.getState().pushToast(errMsg(err), "error");
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex flex-col">
      <GalleryToolbar
        title={t("dashboard:props")}
        count={entries.length}
        onAdd={() => setAdding(true)}
        onPickFromLibrary={() => setPicking(true)}
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 bg-gray-950/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-400">{t("dashboard:prop_list_generation_title")}</div>
          <div className="mt-0.5 truncate text-sm text-gray-500">
            {t("dashboard:prop_list_generation_desc")}
          </div>
        </div>
        <GenerateButton
          onClick={() => onGenerateProps?.()}
          loading={generatingProps}
          disabled={!onGenerateProps || generatingProps}
          label={entries.length === 0
            ? t("dashboard:generate_prop_list")
            : t("dashboard:complete_prop_list")}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
          preflight={onGenerateProps ? {
            projectName,
            taskType: "prop",
            resourceId: "prop-list",
            targetLabel: entries.length === 0
              ? t("dashboard:generate_prop_list")
              : t("dashboard:complete_prop_list"),
            payload: { scope: "prop_list" },
          } : undefined}
        />
        <GenerateButton
          onClick={() => onGenerateMissingProps?.()}
          disabled={!onGenerateMissingProps || missingDesignEntries.length === 0}
          label={entries.length === 0
            ? t("dashboard:generate_props_first")
            : missingDesignEntries.length > 0
            ? t("dashboard:generate_missing_prop_designs", { count: missingDesignCount })
            : t("dashboard:all_prop_designs_ready")}
          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
          preflight={onGenerateMissingProps && missingDesignEntries.length > 0 ? {
            projectName,
            taskType: "prop",
            resourceId: "missing-prop-designs",
            targetLabel: t("dashboard:generate_missing_prop_designs", { count: missingDesignCount }),
            payload: { scope: "missing_prop_designs" },
            count: Math.max(missingDesignCount, 1),
          } : undefined}
        />
      </div>
      <div className="p-4">
        {entries.length === 0 ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="w-full rounded-lg border border-dashed border-gray-700 py-16 text-center text-sm text-gray-500 transition-colors hover:border-indigo-500/60 hover:bg-gray-900/50 hover:text-gray-300 focus-ring"
          >
            {t("dashboard:no_props_hint_clickable")}
          </button>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {entries.map(([name, prop]) => (
              <div id={`prop-${name}`} key={name}>
                <PropCard name={name} prop={prop} projectName={projectName}
                  onUpdate={onUpdateProp}
                  onGenerate={onGenerateProp}
                  onRestoreVersion={onRestorePropVersion}
                  onReload={onRefreshProject}
                  generating={generatingPropNames?.has(name)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <AssetFormModal
          type="prop"
          mode="create"
          onClose={() => setAdding(false)}
          onSubmit={async ({ name, description }) => {
            await onAddProp(name, description);
            setAdding(false);
          }}
        />
      )}

      {picking && (
        <AssetPickerModal
          type="prop"
          existingNames={new Set(Object.keys(props))}
          onClose={() => setPicking(false)}
          onImport={(ids) => { void handleImport(ids); }}
        />
      )}
    </div>
  );
}
