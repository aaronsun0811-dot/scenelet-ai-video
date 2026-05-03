
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle, ChevronLeft, FolderOpen, LogOut, Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useProjectsStore } from "@/stores/projects-store";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { AgentConfigTab } from "./AgentConfigTab";
import { ApiKeysTab } from "./ApiKeysTab";
import { CreateProjectModal } from "./CreateProjectModal";
import { AboutSection } from "./settings/AboutSection";
import { API } from "@/api";
import { MediaModelSection } from "./settings/MediaModelSection";
import { ProviderSection } from "./ProviderSection";
import { UsageStatsSection } from "./settings/UsageStatsSection";
import { StripeSandboxSection } from "./settings/StripeSandboxSection";
import { ProjectNamespaceMigrationSection } from "./settings/ProjectNamespaceMigrationSection";
import { UserAdminSection } from "./settings/UserAdminSection";
import { TravelMapSettingsSection } from "./settings/TravelMapSettingsSection";
import { rememberAssetLibraryReturnTo } from "@/utils/asset-library-return";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsSection = "agent" | "providers" | "media" | "maps" | "usage" | "billing" | "users" | "maintenance" | "api-keys" | "about";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SystemConfigPage() {
  const { t } = useTranslation(["common", "dashboard", "assets"]);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const logout = useAuthStore((s) => s.logout);
  const authRole = useAuthStore((s) => s.role);
  const showCreateModal = useProjectsStore((s) => s.showCreateModal);
  const setShowCreateModal = useProjectsStore((s) => s.setShowCreateModal);
  const [verifiedRole, setVerifiedRole] = useState<string | null | undefined>(authRole ?? undefined);

  const activeSection = useMemo((): SettingsSection => {
    const section = new URLSearchParams(search).get("section");
    if (section === "providers") return "providers";
    if (section === "media") return "media";
    if (section === "maps") return "maps";
    if (section === "usage") return "usage";
    if (section === "billing") return "billing";
    if (section === "users") return "users";
    if (section === "maintenance") return "maintenance";
    if (section === "api-keys") return "api-keys";
    if (section === "about") return "about";
    return "agent";
  }, [search]);

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const openAssetLibrary = () => {
    rememberAssetLibraryReturnTo(`${location}${search ? `?${search}` : ""}`);
    navigate("/app/assets");
  };

  const configIssues = useConfigStatusStore((s) => s.issues);
  const fetchConfigStatus = useConfigStatusStore((s) => s.fetch);
  const isAdmin = (authRole ?? verifiedRole) === "admin";
  const isCheckingRole = authRole === null && verifiedRole === undefined;
  const isAdminOnlySection = activeSection === "users" || activeSection === "maintenance";

  useEffect(() => {
    void fetchConfigStatus();
  }, [fetchConfigStatus]);

  useEffect(() => {
    if (authRole !== null) {
      return;
    }

    let disposed = false;
    API.verifyAuth()
      .then((auth) => {
        if (!disposed) setVerifiedRole(auth.role);
      })
      .catch(() => {
        if (!disposed) setVerifiedRole(null);
      });
    return () => {
      disposed = true;
    };
  }, [authRole]);

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      {/* Page header */}
      <header className="shrink-0 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              href="/app/projects"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 hover:border-gray-700 hover:bg-gray-800 focus-ring"
              aria-label={t("common:back")}
            >
              <ChevronLeft className="h-4 w-4" />
              {t("common:back")}
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-gray-100">{t("common:settings")}</h1>
              <p className="text-xs text-gray-500">{t("dashboard:system_config_title")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/app/projects")}
              aria-label="顶部创作项目"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800"
            >
              <FolderOpen className="h-4 w-4" />
              {t("dashboard:projects")}
            </button>
            <button
              type="button"
              onClick={openAssetLibrary}
              aria-label="顶部资产库"
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-200 transition-colors hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-white"
            >
              <Package className="h-4 w-4" />
              {t("assets:library_title")}
            </button>
            <LanguageSwitch showLabel />
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-900/70 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-700 hover:bg-gray-800 hover:text-white"
              aria-label={t("common:logout")}
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">{t("common:logout")}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex min-h-0 flex-1">
        <AppSidebar
          activeSettingsSection={activeSection}
          responsive={false}
          onImportZip={() => navigate("/app/projects?importZip=1")}
          onCreateProject={() => setShowCreateModal(true)}
        />

        {/* Content area — main is the scroll container.
            providers section bypasses the centered padded wrapper so its sticky bottom bar
            can truly hug the viewport edge (and sidebar can sticky-top across full height). */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {activeSection === "providers" ? (
            <ProviderSection />
          ) : (
            <div className="mx-auto max-w-4xl px-8 py-8">
              {/* Quick alert for config issues */}
              {configIssues.length > 0 && (
                <div className="mb-8 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
                  <div className="flex items-center gap-2 mb-2 text-rose-400">
                    <AlertTriangle className="h-4 w-4" />
                    <h2 className="text-sm font-semibold">{t("dashboard:config_issues")}</h2>
                  </div>
                  <p className="text-xs text-rose-200/70 mb-3">
                    {t("dashboard:config_issues_hint")}
                  </p>
                  <ul className="space-y-1.5">
                    {configIssues.map((issue, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-rose-200/60">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-rose-500/40" />
                        {t(`dashboard:${issue.label}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {isAdminOnlySection && !isAdmin ? (
                <AdminOnlyNotice loading={isCheckingRole} />
              ) : (
                <>
                  {activeSection === "agent" && <AgentConfigTab visible />}
                  {activeSection === "media" && <MediaModelSection />}
                  {activeSection === "maps" && <TravelMapSettingsSection />}
                  {activeSection === "usage" && <UsageStatsSection />}
                  {activeSection === "billing" && <StripeSandboxSection />}
                  {activeSection === "users" && <UserAdminSection />}
                  {activeSection === "maintenance" && <ProjectNamespaceMigrationSection />}
                  {activeSection === "api-keys" && (
                    <div className="p-6">
                      <ApiKeysTab />
                    </div>
                  )}
                  {activeSection === "about" && <AboutSection />}
                </>
              )}
            </div>
          )}
        </main>
      </div>
      {showCreateModal && <CreateProjectModal />}
    </div>
  );
}

function AdminOnlyNotice({ loading }: { loading: boolean }) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-5 text-amber-50">
      <h2 className="text-sm font-semibold">
        {loading ? t("admin_access_checking") : t("admin_access_required_title")}
      </h2>
      <p className="mt-2 text-sm leading-6 text-amber-100/75">
        {loading ? t("admin_access_checking_desc") : t("admin_access_required_desc")}
      </p>
    </div>
  );
}
