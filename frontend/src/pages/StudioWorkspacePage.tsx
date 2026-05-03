import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { StudioCanvasRouter } from "@/components/canvas/StudioCanvasRouter";
import { StudioLayout } from "@/components/layout";
import { useAssistantStore } from "@/stores/assistant-store";
import { useProjectsStore } from "@/stores/projects-store";
import { errMsg } from "@/utils/async";

export function StudioWorkspacePage() {
  const params = useParams<{ projectName: string }>();
  const projectName = params.projectName ?? null;
  const { setCurrentProject, setProjectDetailLoading } = useProjectsStore();
  const [projectLoadError, setProjectLoadError] = useState<{
    projectName: string;
    message: string;
  } | null>(null);
  const activeProjectLoadError = projectLoadError?.projectName === projectName ? projectLoadError : null;

  useEffect(() => {
    if (!projectName) return;
    let cancelled = false;

    const assistantState = useAssistantStore.getState();
    assistantState.setSessions([]);
    assistantState.setCurrentSessionId(null);
    assistantState.setTurns([]);
    assistantState.setDraftTurn(null);
    assistantState.setSessionStatus(null);
    assistantState.setIsDraftSession(false);

    setProjectDetailLoading(true);
    API.getProject(projectName)
      .then((res) => {
        if (!cancelled) {
          setProjectLoadError(null);
          setCurrentProject(projectName, res.project, res.scripts ?? {}, res.asset_fingerprints);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setProjectLoadError({ projectName, message: errMsg(err) });
          setCurrentProject(null, null);
        }
      })
      .finally(() => {
        if (!cancelled) setProjectDetailLoading(false);
      });

    return () => {
      cancelled = true;
      setCurrentProject(null, null);
    };
  }, [projectName, setCurrentProject, setProjectDetailLoading]);

  return (
    <StudioLayout>
      {activeProjectLoadError ? (
        <ProjectLoadError projectName={projectName} message={activeProjectLoadError.message} />
      ) : (
        <StudioCanvasRouter />
      )}
    </StudioLayout>
  );
}

function ProjectLoadError({
  projectName,
  message,
}: {
  projectName: string | null;
  message: string;
}) {
  const { t } = useTranslation("dashboard");
  const [, setLocation] = useLocation();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md rounded-xl border border-amber-300/20 bg-amber-300/10 p-6 text-center text-amber-50">
        <h2 className="text-base font-semibold">{t("project_load_failed_title")}</h2>
        <p className="mt-3 text-sm leading-6 text-amber-100/80">
          {t("project_load_failed_desc", { name: projectName ?? "" })}
        </p>
        <p className="mt-2 text-xs text-amber-100/60">{message}</p>
        <button
          type="button"
          onClick={() => setLocation("~/app/projects")}
          className="mt-5 inline-flex items-center justify-center rounded-lg border border-amber-200/30 bg-amber-200/10 px-4 py-2 text-sm font-medium text-amber-50 transition-colors hover:bg-amber-200/15"
        >
          {t("project_load_failed_action")}
        </button>
      </div>
    </div>
  );
}
