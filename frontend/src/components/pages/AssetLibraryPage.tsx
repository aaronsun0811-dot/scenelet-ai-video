import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronLeft,
  FolderOpen,
  Landmark,
  LogOut,
  Package as PackageIcon,
  Plus,
  Search,
  Settings,
  User,
} from "lucide-react";
import { AssetGrid } from "@/components/assets/AssetGrid";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { useAssetsStore } from "@/stores/assets-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useProjectsStore } from "@/stores/projects-store";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { CreateProjectModal } from "./CreateProjectModal";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { errMsg } from "@/utils/async";
import { consumeAssetLibraryReturnTo } from "@/utils/asset-library-return";
import type { Asset, AssetType } from "@/types/asset";

interface TabDef {
  type: AssetType;
  icon: React.ComponentType<{ className?: string }>;
}

const TABS: TabDef[] = [
  { type: "character", icon: User },
  { type: "scene", icon: Landmark },
  { type: "prop", icon: PackageIcon },
];

function isAssetType(value: string | null): value is AssetType {
  return value === "character" || value === "scene" || value === "prop";
}

const EMPTY_KEY: Record<AssetType, string> = {
  character: "library_empty_character",
  scene: "library_empty_scene",
  prop: "library_empty_prop",
};

export function AssetLibraryPage() {
  const { t } = useTranslation(["assets", "dashboard", "common"]);
  const { t: tCommon } = useTranslation("common");
  const [, navigate] = useLocation();
  const search = useSearch();
  const logout = useAuthStore((s) => s.logout);
  const showCreateModal = useProjectsStore((s) => s.showCreateModal);
  const setShowCreateModal = useProjectsStore((s) => s.setShowCreateModal);
  const fetchConfigStatus = useConfigStatusStore((s) => s.fetch);
  const [activeTab, setActiveTab] = useState<AssetType>("character");
  const [q, setQ] = useState("");
  const [travelReferencePath, setTravelReferencePath] = useState<string | null>(null);
  const [highlightedAssetId, setHighlightedAssetId] = useState<string | null>(null);
  const [targetProjectName, setTargetProjectName] = useState<string | null>(null);
  const [applyingTravelAsset, setApplyingTravelAsset] = useState(false);
  const debouncedQ = useDebouncedValue(q, 250);
  const [formModal, setFormModal] = useState<{ mode: "create" | "edit"; asset?: Asset } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);

  const byType = useAssetsStore((s) => s.byType);
  const loadList = useAssetsStore((s) => s.loadList);
  const addAsset = useAssetsStore((s) => s.addAsset);
  const updateAsset = useAssetsStore((s) => s.updateAsset);
  const deleteAssetLocal = useAssetsStore((s) => s.deleteAsset);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const type = params.get("type");
    const query = params.get("q");
    const travelRef = params.get("travelRef");
    const focus = params.get("focus");
    const targetProject = params.get("targetProject");

    if (isAssetType(type)) setActiveTab(type);
    if (query !== null) setQ(query);
    setTravelReferencePath(travelRef?.trim() || null);
    setHighlightedAssetId(focus?.trim() || null);
    setTargetProjectName(targetProject?.trim() || null);
  }, [search]);

  useEffect(() => {
    void loadList(activeTab, debouncedQ || undefined);
  }, [activeTab, debouncedQ, loadList]);

  useEffect(() => {
    void fetchConfigStatus();
  }, [fetchConfigStatus]);

  const assets = byType[activeTab];

  const handleSubmit = async (payload: {
    name: string; description: string; voice_style: string; image?: File | null;
  }) => {
    try {
      if (formModal?.mode === "edit" && formModal.asset) {
        const { asset } = await API.updateAsset(formModal.asset.id, {
          name: payload.name, description: payload.description, voice_style: payload.voice_style,
        });
        if (payload.image) {
          const { asset: after } = await API.replaceAssetImage(asset.id, payload.image);
          updateAsset(after);
        } else {
          updateAsset(asset);
        }
      } else {
        const { asset } = await API.createAsset({
          type: activeTab, name: payload.name, description: payload.description,
          voice_style: payload.voice_style, image: payload.image ?? undefined,
        });
        addAsset(asset);
      }
    } catch (err) {
      useAppStore.getState().pushToast(errMsg(err), "error");
      throw err; // 让 modal 的 submit 感知失败并保留对话框，用户可修正后重试
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const asset = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteAssetLocal(asset.id, asset.type);
    } catch (err) {
      useAppStore.getState().pushToast(errMsg(err), "error");
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const openProjects = (query = "") => {
    navigate(`/app/projects${query}`);
  };

  const handleApplyTravelReferenceAsset = async () => {
    if (!highlightedAssetId || !targetProjectName || applyingTravelAsset) return;
    setApplyingTravelAsset(true);
    try {
      const result = await API.applyAssetsToProject({
        asset_ids: [highlightedAssetId],
        target_project: targetProjectName,
        conflict_policy: "rename",
      });
      const succeeded = result.succeeded[0];
      if (succeeded) {
        useAppStore.getState().pushToast(
          t("travel_reference_apply_success", { name: succeeded.name, project: targetProjectName }),
          "success",
        );
        useAppStore.getState().triggerScrollTo({
          type: "scene",
          id: succeeded.name,
          route: "/scenes",
        });
        navigate(`/app/projects/${encodeURIComponent(targetProjectName)}/scenes`);
        return;
      }

      const skipped = result.skipped[0];
      if (skipped) {
        useAppStore.getState().pushToast(
          t("travel_reference_apply_skipped", { name: skipped.name, project: targetProjectName }),
          "info",
        );
        return;
      }

      const failed = result.failed[0];
      useAppStore.getState().pushToast(
        t("travel_reference_apply_failed", { reason: failed?.reason ?? t("unknown_error") }),
        "error",
      );
    } catch (err) {
      useAppStore.getState().pushToast(errMsg(err), "error");
    } finally {
      setApplyingTravelAsset(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-gray-950 text-gray-100">
      {/* Decorative ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_30%_0%,rgba(99,102,241,0.12),transparent_60%)]"
      />

      {/* ---- Page header ---- */}
      <header className="relative border-b border-gray-800/80 bg-gray-950/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-6 px-6 py-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => {
                navigate(consumeAssetLibraryReturnTo());
              }}
              aria-label={t("back_to_projects")}
              title={t("back_to_projects")}
              className="mt-1 rounded-full border border-gray-800 bg-gray-900/60 p-1.5 text-gray-400 transition-colors hover:border-indigo-500/40 hover:text-indigo-200"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <img
              src="/scenelet-logo-192.png"
              alt="Scenelet"
              className="mt-0.5 h-10 w-10 rounded-xl border border-gray-800 bg-gray-900 p-1 shadow-md shadow-black/40"
            />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-white">
                {t("library_title")}
              </h1>
              <p className="mt-1 text-sm text-gray-500">{t("library_subtitle")}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openProjects()}
              aria-label="顶部创作项目"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800"
            >
              <FolderOpen className="h-4 w-4" />
              {t("dashboard:projects")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/app/assets")}
              aria-current="page"
              aria-label="顶部资产库"
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-200 transition-colors hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-white"
            >
              <PackageIcon className="h-4 w-4" />
              {t("library_title")}
            </button>
            <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-1.5 transition-colors focus-within:border-indigo-500/50">
              <Search className="h-3.5 w-3.5 text-gray-500" />
              <input
                type="text"
                placeholder={t("search_placeholder")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-44 bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600"
              />
            </div>
            <button
              onClick={() => setFormModal({ mode: "create" })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-lg shadow-indigo-900/40 transition-all hover:bg-indigo-500 hover:shadow-indigo-700/50"
            >
              <Plus className="h-4 w-4" />
              {t("add_asset")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/app/settings")}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title={tCommon("settings")}
              aria-label={tCommon("settings")}
            >
              <Settings className="h-4 w-4" />
            </button>
            <LanguageSwitch />
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title={tCommon("logout")}
              aria-label={tCommon("logout")}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <nav className="mx-auto flex max-w-6xl items-center gap-1 px-6">
          {TABS.map(({ type, icon: Icon }) => {
            const active = activeTab === type;
            const count = byType[type].length;
            return (
              <button
                key={type}
                type="button"
                onClick={() => setActiveTab(type)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                  active ? "text-white" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-indigo-400" : ""}`} />
                <span className="font-medium">{t(`type.${type}`)}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                    active
                      ? "bg-indigo-500/20 text-indigo-200"
                      : "bg-gray-800 text-gray-500"
                  }`}
                >
                  {count}
                </span>
                {active && (
                  <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-indigo-400" />
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {/* ---- Main content ---- */}
      <div className="relative flex flex-1">
        <AppSidebar
          activeMain="assets"
          onImportZip={() => openProjects("?importZip=1")}
          onCreateProject={() => setShowCreateModal(true)}
        />

        <main className="relative mx-auto min-w-0 w-full max-w-6xl flex-1 px-6 py-8">
          {travelReferencePath && (
            <div className="mb-5 rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-50">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">{t("travel_reference_search_title")}</p>
                  <p className="mt-1 break-all text-xs leading-5 text-cyan-100/75">
                    {t("travel_reference_search_desc", {
                      path: travelReferencePath,
                      query: q || travelReferencePath,
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setQ("");
                      setTravelReferencePath(null);
                      setHighlightedAssetId(null);
                      setTargetProjectName(null);
                      navigate("/app/assets");
                    }}
                    className="inline-flex items-center justify-center rounded-lg border border-cyan-200/20 px-3 py-1.5 text-xs font-medium text-cyan-50 transition-colors hover:bg-cyan-200/10"
                  >
                    {t("clear_search")}
                  </button>
                  {targetProjectName && highlightedAssetId && (
                    <button
                      type="button"
                      onClick={() => void handleApplyTravelReferenceAsset()}
                      disabled={applyingTravelAsset}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-gray-950 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <PackageIcon className="h-3.5 w-3.5" />
                      {applyingTravelAsset ? t("applying_to_project") : t("apply_to_project")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {assets.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-gray-800 bg-gray-900/30 py-24 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-gray-500">
                {activeTab === "character" && <User className="h-5 w-5" />}
                {activeTab === "scene" && <Landmark className="h-5 w-5" />}
                {activeTab === "prop" && <PackageIcon className="h-5 w-5" />}
              </div>
              <p className="text-sm font-medium text-gray-300">{t(EMPTY_KEY[activeTab])}</p>
              <p className="max-w-sm text-xs leading-5 text-gray-600">{t("library_empty_hint")}</p>
              <button
                onClick={() => setFormModal({ mode: "create" })}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-lg shadow-indigo-900/40 transition-all hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" />
                {t("add_asset")}
              </button>
            </div>
          ) : (
            <AssetGrid
              assets={assets}
              highlightedAssetId={highlightedAssetId}
              onEdit={(a) => setFormModal({ mode: "edit", asset: a })}
              onDelete={(a) => setDeleteTarget(a)}
            />
          )}
        </main>
      </div>

      {formModal && (
        <AssetFormModal
          type={formModal.asset?.type ?? activeTab}
          mode={formModal.mode}
          initialData={formModal.asset}
          previewImageUrl={
            formModal.asset
              ? API.getGlobalAssetUrl(formModal.asset.image_path, formModal.asset.updated_at) ?? undefined
              : undefined
          }
          onClose={() => setFormModal(null)}
          onSubmit={handleSubmit}
        />
      )}
      {showCreateModal && <CreateProjectModal />}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button
            type="button"
            aria-label={t("cancel")}
            onClick={() => setDeleteTarget(null)}
            className="absolute inset-0 bg-black/70"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("delete_confirm", { type: t(`type.${deleteTarget.type}`) })}
            className="relative w-[420px] max-w-[96vw] rounded-xl border border-gray-700 bg-gray-900 p-5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {t("delete_confirm", { type: t(`type.${deleteTarget.type}`) })}
                </h3>
                <p className="mt-1 text-xs text-gray-400">「{deleteTarget.name}」</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-gray-800 px-4 py-1.5 text-sm text-gray-300 hover:border-gray-600 hover:text-white"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-red-900/40 hover:bg-red-500"
              >
                {t("delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
