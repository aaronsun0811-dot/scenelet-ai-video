import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Filter, MapPinned, PackageCheck } from "lucide-react";
import { GalleryToolbar } from "./GalleryToolbar";
import { SceneCard } from "./SceneCard";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { AssetPickerModal } from "@/components/assets/AssetPickerModal";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { errMsg } from "@/utils/async";
import type { Scene } from "@/types";

interface Props {
  projectName: string;
  scenes: Record<string, Scene>;
  onUpdateScene: (name: string, updates: Partial<Scene>) => void;
  onGenerateScenes?: () => void;
  onGenerateScene: (name: string) => void;
  onGenerateMissingScenes?: () => void;
  onAddScene: (name: string, description: string) => Promise<void>;
  onRestoreSceneVersion?: () => Promise<void> | void;
  onRefreshProject?: () => Promise<void> | void;
  generatingScenes?: boolean;
  generatingSceneNames?: Set<string>;
}

type SceneSourceFilter = "all" | "asset_library" | "travel_reference";

function getSceneSourceFilter(scene: Scene): Exclude<SceneSourceFilter, "all"> | null {
  if (scene.asset_source?.source_kind === "travel_reference") return "travel_reference";
  if (scene.asset_source?.kind === "asset_library") return "asset_library";
  return null;
}

export function ScenesPage({
  projectName,
  scenes,
  onUpdateScene,
  onGenerateScenes,
  onGenerateScene,
  onGenerateMissingScenes,
  onAddScene,
  onRestoreSceneVersion,
  onRefreshProject,
  generatingScenes,
  generatingSceneNames,
}: Props) {
  const { t } = useTranslation(["dashboard", "assets"]);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  useScrollTarget("scene");

  const entries = Object.entries(scenes);
  const sourceCounts = entries.reduce<Record<SceneSourceFilter, number>>(
    (acc, [, scene]) => {
      acc.all += 1;
      const source = getSceneSourceFilter(scene);
      if (source) acc[source] += 1;
      return acc;
    },
    { all: 0, asset_library: 0, travel_reference: 0 },
  );
  const [sourceFilter, setSourceFilter] = useState<SceneSourceFilter>("all");
  const visibleEntries = sourceFilter === "all"
    ? entries
    : entries.filter(([, scene]) => getSceneSourceFilter(scene) === sourceFilter);
  const missingDesignEntries = entries.filter(([, scene]) => !scene.scene_sheet);
  const submittableMissingDesignCount = missingDesignEntries.filter(
    ([name]) => !generatingSceneNames?.has(name),
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
        title={t("dashboard:scenes")}
        count={entries.length}
        onAdd={() => setAdding(true)}
        onPickFromLibrary={() => setPicking(true)}
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 bg-gray-950/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-400">{t("dashboard:scene_list_generation_title")}</div>
          <div className="mt-0.5 truncate text-sm text-gray-500">
            {t("dashboard:scene_list_generation_desc")}
          </div>
        </div>
        <GenerateButton
          onClick={() => onGenerateScenes?.()}
          loading={generatingScenes}
          disabled={!onGenerateScenes || generatingScenes}
          label={entries.length === 0
            ? t("dashboard:generate_scene_list")
            : t("dashboard:complete_scene_list")}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
          preflight={onGenerateScenes ? {
            projectName,
            taskType: "scene",
            resourceId: "scene-list",
            targetLabel: entries.length === 0
              ? t("dashboard:generate_scene_list")
              : t("dashboard:complete_scene_list"),
            payload: { scope: "scene_list" },
          } : undefined}
        />
        <GenerateButton
          onClick={() => onGenerateMissingScenes?.()}
          disabled={!onGenerateMissingScenes || missingDesignEntries.length === 0}
          label={entries.length === 0
            ? t("dashboard:generate_scenes_first")
            : missingDesignEntries.length > 0
            ? t("dashboard:generate_missing_scene_designs", { count: missingDesignCount })
            : t("dashboard:all_scene_designs_ready")}
          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
          preflight={onGenerateMissingScenes && missingDesignEntries.length > 0 ? {
            projectName,
            taskType: "scene",
            resourceId: "missing-scene-designs",
            targetLabel: t("dashboard:generate_missing_scene_designs", { count: missingDesignCount }),
            payload: { scope: "missing_scene_designs" },
            count: Math.max(missingDesignCount, 1),
          } : undefined}
        />
      </div>
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-800/80 bg-gray-950/30 px-4 py-2.5">
          <div className="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-gray-500">
            <Filter className="h-3.5 w-3.5" />
            {t("scene_source_filter_label")}
          </div>
          {([
            ["all", null],
            ["asset_library", PackageCheck],
            ["travel_reference", MapPinned],
          ] as const).map(([filter, Icon]) => {
            const active = sourceFilter === filter;
            const disabled = sourceCounts[filter] === 0;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setSourceFilter(filter)}
                disabled={disabled}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-cyan-300/50 bg-cyan-400/15 text-cyan-100"
                    : "border-gray-800 bg-gray-900/50 text-gray-400 hover:border-gray-700 hover:text-gray-200"
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                {Icon && <Icon className="h-3 w-3" />}
                {t(`scene_source_filter_${filter}`)}
                <span className="tabular-nums text-gray-500">{sourceCounts[filter]}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="p-4">
        {entries.length === 0 ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="w-full rounded-lg border border-dashed border-gray-700 py-16 text-center text-sm text-gray-500 transition-colors hover:border-indigo-500/60 hover:bg-gray-900/50 hover:text-gray-300 focus-ring"
          >
            {t("dashboard:no_scenes_hint_clickable")}
          </button>
        ) : visibleEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-800 bg-gray-900/30 py-12 text-center text-sm text-gray-500">
            {t("scene_source_filter_empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {visibleEntries.map(([name, scene]) => (
              <div id={`scene-${name}`} key={name}>
                <SceneCard name={name} scene={scene} projectName={projectName}
                  onUpdate={onUpdateScene}
                  onGenerate={onGenerateScene}
                  onRestoreVersion={onRestoreSceneVersion}
                  onReload={onRefreshProject}
                  generating={generatingSceneNames?.has(name)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <AssetFormModal
          type="scene"
          mode="create"
          onClose={() => setAdding(false)}
          onSubmit={async ({ name, description }) => {
            await onAddScene(name, description);
            setAdding(false);
          }}
        />
      )}

      {picking && (
        <AssetPickerModal
          type="scene"
          existingNames={new Set(Object.keys(scenes))}
          onClose={() => setPicking(false)}
          onImport={(ids) => { void handleImport(ids); }}
        />
      )}
    </div>
  );
}
