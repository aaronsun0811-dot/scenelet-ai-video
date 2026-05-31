import { useEffect } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CreditCard,
  Film,
  FolderOpen,
  Info,
  KeyRound,
  Languages,
  Loader2,
  MapPinned,
  Package,
  Plug,
  Plus,
  ShieldCheck,
  Upload,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useAuthStore } from "@/stores/auth-store";
import { getNextLanguage, normalizeLanguage, SUPPORTED_LANGUAGES } from "@/i18n/languages";
import { rememberAssetLibraryReturnTo } from "@/utils/asset-library-return";

export type AppSidebarMain = "projects" | "assets" | "admin" | null;
export type AppSidebarSettingsSection =
  | "agent"
  | "providers"
  | "media"
  | "maps"
  | "usage"
  | "billing"
  | "users"
  | "maintenance"
  | "api-keys"
  | "about"
  | null;

const SETTINGS_SHORTCUTS: {
  section: Exclude<AppSidebarSettingsSection, null>;
  labelKey: string;
  Icon: LucideIcon;
  issueSensitive?: boolean;
  adminOnly?: boolean;
  ariaLabel: string;
}[] = [
  { section: "agent", labelKey: "dashboard:agents", Icon: Bot, issueSensitive: true, ariaLabel: "侧边栏智能体设置" },
  { section: "providers", labelKey: "dashboard:providers", Icon: Plug, issueSensitive: true, ariaLabel: "侧边栏供应商设置" },
  { section: "media", labelKey: "dashboard:models", Icon: Film, issueSensitive: true, ariaLabel: "侧边栏模型选择设置" },
  { section: "maps", labelKey: "dashboard:maps_settings", Icon: MapPinned, ariaLabel: "侧边栏地图与旅游设置" },
  { section: "usage", labelKey: "dashboard:usage", Icon: BarChart3, ariaLabel: "侧边栏用量统计" },
  { section: "billing", labelKey: "dashboard:billing_settings", Icon: CreditCard, ariaLabel: "侧边栏支付联调" },
  { section: "users", labelKey: "dashboard:users", Icon: Users, adminOnly: true, ariaLabel: "侧边栏用户设置" },
  { section: "maintenance", labelKey: "dashboard:maintenance", Icon: Wrench, adminOnly: true, ariaLabel: "侧边栏维护设置" },
  { section: "api-keys", labelKey: "dashboard:api_keys", Icon: KeyRound, ariaLabel: "侧边栏 API 令牌设置" },
  { section: "about", labelKey: "dashboard:about", Icon: Info, ariaLabel: "侧边栏关于设置" },
];

interface AppSidebarProps {
  activeMain?: AppSidebarMain;
  activeSettingsSection?: AppSidebarSettingsSection;
  className?: string;
  responsive?: boolean;
  importZipLoading?: boolean;
  onImportZip?: () => void;
  onCreateProject?: () => void;
  onNavigate?: (path: string) => void;
}

function navItemClass(active: boolean) {
  return active
    ? "flex w-full items-center gap-3 border-l-2 border-indigo-500 bg-gray-800/50 px-4 py-2.5 text-sm text-white"
    : "flex w-full items-center gap-3 border-l-2 border-transparent px-4 py-2.5 text-sm text-gray-400 transition-colors hover:border-indigo-500 hover:bg-gray-800/30 hover:text-gray-200";
}

export function AppSidebar({
  activeMain = null,
  activeSettingsSection = null,
  className = "",
  responsive = true,
  importZipLoading = false,
  onImportZip,
  onCreateProject,
  onNavigate,
}: AppSidebarProps) {
  const { t, i18n } = useTranslation(["common", "dashboard", "assets"]);
  const [location, navigate] = useLocation();
  const configIssues = useConfigStatusStore((s) => s.issues);
  const fetchConfigStatus = useConfigStatusStore((s) => s.fetch);
  const role = useAuthStore((s) => s.role);
  const canSeeAdminShortcuts = role !== "user";
  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage || i18n.language);
  const currentLanguageMeta = SUPPORTED_LANGUAGES.find((item) => item.code === currentLanguage) ?? SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    void fetchConfigStatus();
  }, [fetchConfigStatus]);

  const go = (path: string) => {
    if (onNavigate) {
      onNavigate(path);
      return;
    }
    navigate(path);
  };

  const openAssetLibrary = () => {
    if (activeMain !== "assets") {
      const current = typeof window === "undefined" ? location : `${window.location.pathname}${window.location.search}`;
      rememberAssetLibraryReturnTo(current);
    }
    go("/app/assets");
  };

  const openImportZip = () => {
    if (onImportZip) {
      onImportZip();
      return;
    }
    go("/app/projects?importZip=1");
  };

  const createProject = () => {
    if (onCreateProject) {
      onCreateProject();
      return;
    }
    go("/app/projects?createProject=1");
  };

  const rootClass = [
    responsive ? "hidden lg:block" : "",
    "w-48 shrink-0 border-r border-gray-800 bg-gray-950/50 py-4",
    className,
  ].filter(Boolean).join(" ");

  return (
    <aside className={rootClass}>
      <div className="px-4 pb-2 text-xs font-medium uppercase tracking-normal text-gray-600">
        {t("dashboard:projects")}
      </div>
      <button
        type="button"
        onClick={() => go("/app/projects")}
        aria-current={activeMain === "projects" ? "page" : undefined}
        aria-label="侧边栏创作项目"
        className={navItemClass(activeMain === "projects")}
      >
        <FolderOpen className="h-4 w-4" />
        <span className="flex-1 text-left">{t("dashboard:projects")}</span>
      </button>
      <button
        type="button"
        onClick={openAssetLibrary}
        aria-current={activeMain === "assets" ? "page" : undefined}
        aria-label="侧边栏资产库"
        className={navItemClass(activeMain === "assets")}
      >
        <Package className="h-4 w-4" />
        <span className="flex-1 text-left">{t("assets:library_title")}</span>
      </button>
      <button
        type="button"
        onClick={openImportZip}
        disabled={importZipLoading}
        aria-label="侧边栏导入 ZIP"
        className={`${navItemClass(false)} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {importZipLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        <span className="flex-1 text-left">
          {importZipLoading ? t("dashboard:importing") : t("dashboard:import_zip")}
        </span>
      </button>
      <button
        type="button"
        onClick={createProject}
        aria-label="侧边栏创建项目"
        className={navItemClass(false)}
      >
        <Plus className="h-4 w-4" />
        <span className="flex-1 text-left">{t("dashboard:create_project")}</span>
      </button>
      {canSeeAdminShortcuts && (
        <button
          type="button"
          onClick={() => go("/app/admin")}
          aria-current={activeMain === "admin" || location.startsWith("/app/admin") ? "page" : undefined}
          aria-label="侧边栏管理后台"
          className={navItemClass(activeMain === "admin" || location.startsWith("/app/admin"))}
        >
          <ShieldCheck className="h-4 w-4" />
          <span className="flex-1 text-left">{t("dashboard:admin_console")}</span>
        </button>
      )}

      <div className="my-3 mx-4 border-t border-gray-800" />
      <div className="px-4 pb-2 text-xs font-medium uppercase tracking-normal text-gray-600">
        {t("common:settings")}
      </div>
      {SETTINGS_SHORTCUTS.filter((item) => !item.adminOnly || canSeeAdminShortcuts).map(({ section, labelKey, Icon, issueSensitive, ariaLabel }) => {
        const active = activeSettingsSection === section;
        const hasIssue = Boolean(issueSensitive && configIssues.length > 0);
        return (
          <button
            key={section}
            type="button"
            onClick={() => go(`/app/settings?section=${section}`)}
            aria-current={active ? "page" : undefined}
            aria-label={ariaLabel}
            className={navItemClass(active)}
          >
            <Icon className="h-4 w-4" />
            <span className="flex-1 text-left">{t(labelKey)}</span>
            {hasIssue && <AlertTriangle className="h-3 w-3 text-rose-500" />}
          </button>
        );
      })}

      <div className="my-3 mx-4 border-t border-gray-800" />
      <button
        type="button"
        onClick={() => {
          void i18n.changeLanguage(getNextLanguage(currentLanguage));
        }}
        aria-label="侧边栏语言"
        className={navItemClass(false)}
      >
        <Languages className="h-4 w-4" />
        <span className="flex-1 text-left">{t("dashboard:language_setting")}</span>
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-400">
          {currentLanguageMeta.shortLabel}
        </span>
      </button>
    </aside>
  );
}
