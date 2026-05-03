import { Component, lazy, Suspense, type ReactNode } from "react";
import { Route, Switch, Redirect } from "wouter";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { ToastOverlay } from "@/components/layout/ToastOverlay";
import { useAuthStore } from "@/stores/auth-store";

const LoginPage = lazy(() =>
  import("@/pages/LoginPage").then((module) => ({ default: module.LoginPage })),
);
const ProjectsPage = lazy(() =>
  import("@/components/pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })),
);
const SystemConfigPage = lazy(() =>
  import("@/components/pages/SystemConfigPage").then((module) => ({ default: module.SystemConfigPage })),
);
const AssetLibraryPage = lazy(() =>
  import("@/components/pages/AssetLibraryPage").then((module) => ({ default: module.AssetLibraryPage })),
);
const ProjectSettingsPage = lazy(() =>
  import("@/components/pages/ProjectSettingsPage").then((module) => ({ default: module.ProjectSettingsPage })),
);
const StudioWorkspacePage = lazy(() =>
  import("@/pages/StudioWorkspacePage").then((module) => ({ default: module.StudioWorkspacePage })),
);

function RouteLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-500">
      加载中...
    </div>
  );
}

class RouteErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; message: string }> {
  state = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "页面模块加载失败",
    };
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 px-6 text-gray-300">
        <div className="max-w-md rounded-xl border border-red-400/20 bg-red-500/10 p-5">
          <h1 className="text-base font-semibold text-red-100">页面加载失败</h1>
          <p className="mt-2 text-sm leading-6 text-red-100/80">
            开发服务器模块缓存可能已过期，请刷新页面后重试。
          </p>
          {this.state.message && (
            <p className="mt-3 break-words rounded-lg border border-red-400/15 bg-gray-950/60 px-3 py-2 font-mono text-xs text-red-100/70">
              {this.state.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return <RouteLoading />;
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <>
      <Suspense fallback={<RouteLoading />}>
        <RouteErrorBoundary>
          <Switch>
            {/* Login page */}
            <Route path="/login" component={LoginPage} />

            {/* Root redirects to projects list */}
            <Route path="/">
              <Redirect to="/app/projects" />
            </Route>

            {/* /app and /app/ also redirect to projects list */}
            <Route path="/app">
              <Redirect to="/app/projects" />
            </Route>

            {/* Projects list */}
            <Route path="/app/projects">
              <AuthGuard>
                <ProjectsPage />
              </AuthGuard>
            </Route>

            {/* System settings */}
            <Route path="/app/settings">
              <AuthGuard>
                <SystemConfigPage />
              </AuthGuard>
            </Route>

            {/* Asset library */}
            <Route path="/app/assets">
              <AuthGuard>
                <AssetLibraryPage />
              </AuthGuard>
            </Route>

            {/* Project settings — full-screen, must be before the nested workspace route */}
            <Route path="/app/projects/:projectName/settings">
              <AuthGuard>
                <ProjectSettingsPage />
              </AuthGuard>
            </Route>

            {/* Studio workspace (three-column layout) */}
            <Route path="/app/projects/:projectName" nest>
              <AuthGuard>
                <StudioWorkspacePage />
              </AuthGuard>
            </Route>

            {/* 404 */}
            <Route>
              <NotFoundPage />
            </Route>
          </Switch>
        </RouteErrorBoundary>
      </Suspense>
      <ToastOverlay />
    </>
  );
}
