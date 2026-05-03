import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react";
import { useLocation } from "wouter";
import { GalleryToolbar } from "./GalleryToolbar";
import { CharacterCard } from "./CharacterCard";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { AssetPickerModal } from "@/components/assets/AssetPickerModal";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { errMsg } from "@/utils/async";
import type { Character } from "@/types";

interface Props {
  projectName: string;
  characters: Record<string, Character>;
  onSaveCharacter: (name: string, payload: { description: string; voiceStyle: string; referenceFile?: File | null }) => Promise<void>;
  onGenerateCharacter: (name: string) => void;
  onGenerateCharacters?: () => void;
  onGenerateMissingCharacters?: () => void;
  onAddCharacter: (name: string, description: string, voiceStyle: string, referenceFile?: File | null) => Promise<void>;
  onRestoreCharacterVersion?: () => Promise<void> | void;
  onRefreshProject?: () => Promise<void> | void;
  generatingCharacters?: boolean;
  generatingCharacterNames?: Set<string>;
}

export function CharactersPage({
  projectName,
  characters,
  onSaveCharacter,
  onGenerateCharacter,
  onGenerateCharacters,
  onGenerateMissingCharacters,
  onAddCharacter,
  onRestoreCharacterVersion,
  onRefreshProject,
  generatingCharacters,
  generatingCharacterNames,
}: Props) {
  const { t } = useTranslation(["dashboard", "assets"]);
  const [, setLocation] = useLocation();
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  useScrollTarget("character");
  const characterStylePrompt = useProjectsStore(
    (s) => s.currentProjectData?.character_style_prompt?.trim() ?? "",
  );

  const entries = Object.entries(characters);
  const missingDesignEntries = entries.filter(([, char]) => !char.character_sheet);
  const submittableMissingDesignCount = missingDesignEntries.filter(
    ([name]) => !generatingCharacterNames?.has(name),
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
        title={t("dashboard:characters")}
        count={entries.length}
        onAdd={() => setAdding(true)}
        onPickFromLibrary={() => setPicking(true)}
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 bg-gray-950/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-400">{t("dashboard:character_style_prompt")}</div>
          <div className={`mt-0.5 truncate text-sm ${characterStylePrompt ? "text-gray-200" : "text-gray-500"}`}>
            {characterStylePrompt || t("dashboard:character_style_not_set")}
          </div>
        </div>
        <GenerateButton
          onClick={() => onGenerateCharacters?.()}
          loading={generatingCharacters}
          disabled={!onGenerateCharacters || generatingCharacters}
          label={entries.length === 0
            ? t("dashboard:generate_character_list")
            : t("dashboard:complete_character_list")}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
          preflight={onGenerateCharacters ? {
            projectName,
            taskType: "character",
            resourceId: "character-list",
            targetLabel: entries.length === 0
              ? t("dashboard:generate_character_list")
              : t("dashboard:complete_character_list"),
            payload: { scope: "character_list" },
          } : undefined}
        />
        <button
          type="button"
          onClick={() => setLocation(`~/app/projects/${encodeURIComponent(projectName)}/settings`)}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t("dashboard:character_style_configure")}
        </button>
        <GenerateButton
          onClick={() => onGenerateMissingCharacters?.()}
          disabled={!onGenerateMissingCharacters || missingDesignEntries.length === 0}
          label={entries.length === 0
            ? t("dashboard:generate_characters_first")
            : missingDesignEntries.length > 0
            ? t("dashboard:generate_missing_character_designs", { count: missingDesignCount })
            : t("dashboard:all_character_designs_ready")}
          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-gray-900 disabled:text-gray-600"
          preflight={onGenerateMissingCharacters && missingDesignEntries.length > 0 ? {
            projectName,
            taskType: "character",
            resourceId: "missing-character-designs",
            targetLabel: t("dashboard:generate_missing_character_designs", { count: missingDesignCount }),
            payload: { scope: "missing_character_designs" },
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
            {t("dashboard:no_characters_hint_clickable")}
          </button>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {entries.map(([name, char]) => (
              <div id={`character-${name}`} key={name}>
                <CharacterCard name={name} character={char} projectName={projectName}
                  onSave={onSaveCharacter}
                  onGenerate={onGenerateCharacter}
                  onRestoreVersion={onRestoreCharacterVersion}
                  onReload={onRefreshProject}
                  generating={generatingCharacterNames?.has(name)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <AssetFormModal
          type="character"
          mode="create"
          onClose={() => setAdding(false)}
          onSubmit={async ({ name, description, voice_style, image }) => {
            await onAddCharacter(name, description, voice_style, image ?? null);
            setAdding(false);
          }}
        />
      )}

      {picking && (
        <AssetPickerModal
          type="character"
          existingNames={new Set(Object.keys(characters))}
          onClose={() => setPicking(false)}
          onImport={(ids) => { void handleImport(ids); }}
        />
      )}
    </div>
  );
}
