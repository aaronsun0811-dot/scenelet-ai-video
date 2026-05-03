import { lazy, Suspense, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { errMsg, voidPromise } from "@/utils/async";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useTasksStore } from "@/stores/tasks-store";
import { API, ApiRequestError } from "@/api";
import { buildEntityRevisionKey } from "@/utils/project-changes";
import { getProviderModels, getCustomProviderModels, lookupSupportedDurations } from "@/utils/provider-models";
import { effectiveMode } from "@/utils/generation-mode";
import { getScriptGenerationItems, resolveSegmentPrompt } from "@/utils/script-generation";
import { getActiveGenerationResourceIds } from "@/utils/generation-tasks";
import type { Scene, Prop, CustomProviderInfo, ProviderInfo } from "@/types";

const OverviewCanvas = lazy(() =>
  import("./OverviewCanvas").then((module) => ({ default: module.OverviewCanvas })),
);
const SourceFileViewer = lazy(() =>
  import("./SourceFileViewer").then((module) => ({ default: module.SourceFileViewer })),
);
const TimelineCanvas = lazy(() =>
  import("./timeline/TimelineCanvas").then((module) => ({ default: module.TimelineCanvas })),
);
const ReferenceVideoCanvas = lazy(() =>
  import("./reference/ReferenceVideoCanvas").then((module) => ({ default: module.ReferenceVideoCanvas })),
);
const CharactersPage = lazy(() =>
  import("./lorebook/CharactersPage").then((module) => ({ default: module.CharactersPage })),
);
const ScenesPage = lazy(() =>
  import("./lorebook/ScenesPage").then((module) => ({ default: module.ScenesPage })),
);
const PropsPage = lazy(() =>
  import("./lorebook/PropsPage").then((module) => ({ default: module.PropsPage })),
);

function isInsufficientCreditsError(err: unknown): boolean {
  if (err instanceof ApiRequestError) return err.status === 402;
  return Boolean(err && typeof err === "object" && (err as { status?: unknown }).status === 402);
}

// ---------------------------------------------------------------------------
// StudioCanvasRouter -- reads Zustand store data and renders the correct
// canvas view based on the nested route within /app/projects/:projectName.
// ---------------------------------------------------------------------------

function ProjectSettingsNestedRedirect({ projectName }: { projectName: string }) {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation(`~/app/projects/${encodeURIComponent(projectName)}/settings`);
  }, [projectName, setLocation]);

  return (
    <div className="flex h-full items-center justify-center text-gray-500">
      加载设置...
    </div>
  );
}

function CanvasRouteLoading() {
  return (
    <div className="flex h-full items-center justify-center text-gray-500">
      加载中...
    </div>
  );
}

export function StudioCanvasRouter() {
  const { t } = useTranslation("dashboard");
  const tRef = useRef(t);
  tRef.current = t;
  const { currentProjectData, currentProjectName, currentScripts } =
    useProjectsStore();

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProviderInfo[]>([]);
  const [globalVideoBackend, setGlobalVideoBackend] = useState("");
  const [generatingCharacters, setGeneratingCharacters] = useState(false);
  const [generatingScenes, setGeneratingScenes] = useState(false);
  const [generatingProps, setGeneratingProps] = useState(false);
  const [generatingEpisodeScript, setGeneratingEpisodeScript] = useState<number | null>(null);
  const [generatingEpisodeStoryboards, setGeneratingEpisodeStoryboards] = useState<number | null>(null);
  const [generatingEpisodeVideos, setGeneratingEpisodeVideos] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    Promise.all([getProviderModels(), getCustomProviderModels(), API.getSystemConfig()]).then(
      ([provList, customList, configRes]) => {
        if (disposed) return;
        setProviders(provList);
        setCustomProviders(customList);
        setGlobalVideoBackend(configRes.settings?.default_video_backend ?? "");
      },
    ).catch(() => {});
    return () => { disposed = true; };
  }, []);

  const durationOptions = useMemo(() => {
    const backend = currentProjectData?.video_backend || globalVideoBackend;
    if (!backend) return undefined;
    return lookupSupportedDurations(providers, backend, customProviders);
  }, [providers, customProviders, globalVideoBackend, currentProjectData?.video_backend]);

  const generationFailureMessage = useCallback((err: unknown, fallbackKey: string) => {
    const message = errMsg(err);
    return isInsufficientCreditsError(err)
      ? tRef.current("platform_credits_insufficient_generation", { message })
      : tRef.current(fallbackKey, { message });
  }, []);
  const isPlatformCreditsProject = currentProjectData?.billing_mode === "platform_credits";
  const ensureGenerationCredits = useCallback(async () => {
    if (!isPlatformCreditsProject) return true;
    try {
      const credits = await API.getCreditBalance();
      const availableBalance = credits.available_balance ?? credits.balance;
      if (availableBalance >= credits.minimum_generation_balance) return true;
      useAppStore.getState().pushNotification(
        tRef.current("platform_credits_preflight_low_balance", {
          balance: availableBalance.toLocaleString(),
          minimum: credits.minimum_generation_balance.toLocaleString(),
        }),
        "error",
      );
      return false;
    } catch {
      // If the preflight check cannot run, let the generation endpoint enforce billing.
      return true;
    }
  }, [isPlatformCreditsProject]);

  // 从任务队列派生 loading 状态（替代本地 state）
  const tasks = useTasksStore((s) => s.tasks);
  const generatingCharacterNames = useMemo(() => {
    const names = new Set<string>();
    for (const t of tasks) {
      if (
        t.task_type === "character" &&
        t.project_name === currentProjectName &&
        (t.status === "queued" || t.status === "running")
      ) {
        names.add(t.resource_id);
      }
    }
    return names;
  }, [tasks, currentProjectName]);
  const generatingSceneNames = useMemo(() => {
    const names = new Set<string>();
    for (const t of tasks) {
      if (
        t.task_type === "scene" &&
        t.project_name === currentProjectName &&
        (t.status === "queued" || t.status === "running")
      ) {
        names.add(t.resource_id);
      }
    }
    return names;
  }, [tasks, currentProjectName]);
  const generatingPropNames = useMemo(() => {
    const names = new Set<string>();
    for (const t of tasks) {
      if (
        t.task_type === "prop" &&
        t.project_name === currentProjectName &&
        (t.status === "queued" || t.status === "running")
      ) {
        names.add(t.resource_id);
      }
    }
    return names;
  }, [tasks, currentProjectName]);

  // 刷新项目数据
  const refreshProject = useCallback(async (invalidateKeys: string[] = []) => {
    if (!currentProjectName) return;
    try {
      const res = await API.getProject(currentProjectName);
      useProjectsStore.getState().setCurrentProject(
        currentProjectName,
        res.project,
        res.scripts ?? {},
        res.asset_fingerprints,
      );
      if (invalidateKeys.length > 0) {
        useAppStore.getState().invalidateEntities(invalidateKeys);
      }
    } catch {
      // 静默失败
    }
  }, [currentProjectName]);

  // ---- Timeline action callbacks ----
  // These receive scriptFile from TimelineCanvas so they always use the active episode's script.
  const handleUpdatePrompt = useCallback(async (
    segmentId: string,
    fieldOrPatch: string | Record<string, unknown>,
    value?: unknown,
    scriptFile?: string,
  ) => {
    if (!currentProjectName) return;
    const mode = currentProjectData?.content_mode ?? "narration";
    const patch =
      typeof fieldOrPatch === "string"
        ? { [fieldOrPatch]: value }
        : fieldOrPatch;
    try {
      if (mode === "drama") {
        await API.updateScene(currentProjectName, segmentId, scriptFile ?? "", patch);
      } else {
        await API.updateSegment(currentProjectName, segmentId, { script_file: scriptFile, ...patch });
      }
      await refreshProject();
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("update_prompt_failed", { message: errMsg(err) }), "error");
    }
  }, [currentProjectName, currentProjectData, refreshProject]);

  const handleGenerateStoryboard = useCallback(async (segmentId: string, scriptFile?: string) => {
    if (!currentProjectName || !currentScripts) return;
    const resolved = resolveSegmentPrompt(currentScripts, segmentId, "image_prompt", scriptFile);
    if (!resolved) return;
    if (getActiveGenerationResourceIds(tasks, currentProjectName, "storyboard", resolved.resolvedFile).has(segmentId)) {
      useAppStore
        .getState()
        .pushToast(tRef.current("storyboard_task_already_active", { id: segmentId }), "warning");
      return;
    }
    if (!(await ensureGenerationCredits())) return;
    try {
      await API.generateStoryboard(
        currentProjectName,
        segmentId,
        resolved.prompt as string | Record<string, unknown>,
        resolved.resolvedFile,
      );
      useAppStore.getState().pushToast(tRef.current("storyboard_task_submitted_toast", { id: segmentId }), "success");
    } catch (err) {
      useAppStore.getState().pushNotification(generationFailureMessage(err, "generate_storyboard_failed"), "error");
    }
  }, [currentProjectName, currentScripts, ensureGenerationCredits, generationFailureMessage, tasks]);

  const handleGenerateVideo = useCallback(async (segmentId: string, scriptFile?: string) => {
    if (!currentProjectName || !currentScripts) return;
    const resolved = resolveSegmentPrompt(currentScripts, segmentId, "video_prompt", scriptFile);
    if (!resolved) return;
    if (getActiveGenerationResourceIds(tasks, currentProjectName, "video", resolved.resolvedFile).has(segmentId)) {
      useAppStore
        .getState()
        .pushToast(tRef.current("video_task_already_active", { id: segmentId }), "warning");
      return;
    }
    if (!(await ensureGenerationCredits())) return;
    try {
      await API.generateVideo(
        currentProjectName,
        segmentId,
        resolved.prompt as string | Record<string, unknown>,
        resolved.resolvedFile,
        resolved.duration,
      );
      useAppStore.getState().pushToast(tRef.current("video_task_submitted_toast", { id: segmentId }), "success");
    } catch (err) {
      useAppStore.getState().pushNotification(generationFailureMessage(err, "generate_video_failed"), "error");
    }
  }, [currentProjectName, currentScripts, ensureGenerationCredits, generationFailureMessage, tasks]);

  const handleGenerateEpisodeScript = useCallback(async (episode: number) => {
    if (!currentProjectName || generatingEpisodeScript != null) return;
    if (!(await ensureGenerationCredits())) return;
    setGeneratingEpisodeScript(episode);
    try {
      await API.generateEpisodeScript(currentProjectName, episode);
      await refreshProject();
      useAppStore
        .getState()
        .pushToast(tRef.current("episode_script_generated", { episode }), "success");
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("episode_script_failed", { message: errMsg(err) }), "error");
    } finally {
      setGeneratingEpisodeScript(null);
    }
  }, [
    currentProjectName,
    ensureGenerationCredits,
    generatingEpisodeScript,
    refreshProject,
  ]);

  const handleGenerateEpisodeStoryboards = useCallback(async (episode: number, scriptFile: string) => {
    if (!currentProjectName || generatingEpisodeStoryboards != null) return;
    const script = currentScripts[scriptFile];
    if (!script) return;
    const activeStoryboardIds = getActiveGenerationResourceIds(tasks, currentProjectName, "storyboard", scriptFile);
    const rawMissingItems = getScriptGenerationItems(script).filter((item) => !item.hasStoryboard);
    const missingItems = rawMissingItems.filter(
      (item) => !item.hasStoryboard && !activeStoryboardIds.has(item.id),
    );
    if (missingItems.length === 0) {
      useAppStore
        .getState()
        .pushToast(
          tRef.current(rawMissingItems.length > 0 ? "storyboard_batch_already_active" : "storyboard_batch_no_missing"),
          "warning",
        );
      return;
    }
    if (!(await ensureGenerationCredits())) return;

    setGeneratingEpisodeStoryboards(episode);
    try {
      const results = await Promise.allSettled(
        missingItems.map((item) =>
          API.generateStoryboard(
            currentProjectName,
            item.id,
            item.imagePrompt as string | Record<string, unknown>,
            scriptFile,
          ),
        ),
      );
      const submitted = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - submitted;
      if (submitted > 0) {
        useAppStore
          .getState()
          .pushToast(tRef.current("storyboard_batch_submitted_toast", { count: submitted }), "success");
      }
      if (failed > 0) {
        const firstFailure = results.find((result) => result.status === "rejected");
        const reason: unknown =
          firstFailure?.status === "rejected" ? (firstFailure.reason as unknown) : undefined;
        const message = errMsg(reason);
        const text = isInsufficientCreditsError(reason)
          ? tRef.current("platform_credits_insufficient_generation", { message })
          : tRef.current("storyboard_batch_failed", { count: failed, message });
        useAppStore.getState().pushNotification(text, "error");
      }
    } finally {
      setGeneratingEpisodeStoryboards(null);
    }
  }, [
    currentProjectName,
    currentScripts,
    ensureGenerationCredits,
    generatingEpisodeStoryboards,
    tasks,
  ]);

  const handleGenerateEpisodeVideos = useCallback(async (episode: number, scriptFile: string) => {
    if (!currentProjectName || generatingEpisodeVideos != null) return;
    const script = currentScripts[scriptFile];
    if (!script) return;
    const activeVideoIds = getActiveGenerationResourceIds(tasks, currentProjectName, "video", scriptFile);
    const rawReadyItems = getScriptGenerationItems(script).filter((item) => item.hasStoryboard && !item.hasVideo);
    const readyItems = rawReadyItems.filter(
      (item) => item.hasStoryboard && !item.hasVideo && !activeVideoIds.has(item.id),
    );
    if (readyItems.length === 0) {
      useAppStore
        .getState()
        .pushToast(
          tRef.current(rawReadyItems.length > 0 ? "video_batch_already_active" : "video_batch_no_missing"),
          "warning",
        );
      return;
    }
    if (!(await ensureGenerationCredits())) return;

    setGeneratingEpisodeVideos(episode);
    try {
      const results = await Promise.allSettled(
        readyItems.map((item) =>
          API.generateVideo(
            currentProjectName,
            item.id,
            item.videoPrompt as string | Record<string, unknown>,
            scriptFile,
            item.duration,
          ),
        ),
      );
      const submitted = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - submitted;
      if (submitted > 0) {
        useAppStore
          .getState()
          .pushToast(tRef.current("video_batch_submitted_toast", { count: submitted }), "success");
      }
      if (failed > 0) {
        const firstFailure = results.find((result) => result.status === "rejected");
        const reason: unknown =
          firstFailure?.status === "rejected" ? (firstFailure.reason as unknown) : undefined;
        const message = errMsg(reason);
        const text = isInsufficientCreditsError(reason)
          ? tRef.current("platform_credits_insufficient_generation", { message })
          : tRef.current("video_batch_failed", { count: failed, message });
        useAppStore.getState().pushNotification(text, "error");
      }
    } finally {
      setGeneratingEpisodeVideos(null);
    }
  }, [
    currentProjectName,
    currentScripts,
    ensureGenerationCredits,
    generatingEpisodeVideos,
    tasks,
  ]);

  // ---- Character CRUD callbacks ----
  const handleSaveCharacter = useCallback(async (
    name: string,
    payload: {
      description: string;
      voiceStyle: string;
      referenceFile?: File | null;
    },
  ) => {
    if (!currentProjectName) return;
    try {
      await API.updateCharacter(currentProjectName, name, {
        description: payload.description,
        voice_style: payload.voiceStyle,
      });

      if (payload.referenceFile) {
        await API.uploadFile(
          currentProjectName,
          "character_ref",
          payload.referenceFile,
          name,
        );
      }

      await refreshProject(
        payload.referenceFile
          ? [buildEntityRevisionKey("character", name)]
          : [],
      );
      useAppStore.getState().pushToast(tRef.current("character_updated_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("update_character_failed", { message: errMsg(err) }), "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleGenerateCharacter = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    if (generatingCharacterNames.has(name)) {
      useAppStore
        .getState()
        .pushToast(tRef.current("character_task_already_active", { name }), "warning");
      return;
    }
    if (!(await ensureGenerationCredits())) return;
    try {
      await API.generateCharacter(
        currentProjectName,
        name,
        currentProjectData?.characters?.[name]?.description ?? "",
      );
      useAppStore
        .getState()
        .pushToast(tRef.current("character_task_submitted_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushNotification(generationFailureMessage(err, "submit_failed"), "error");
    }
  }, [
    currentProjectName,
    currentProjectData,
    ensureGenerationCredits,
    generationFailureMessage,
    generatingCharacterNames,
  ]);

  const handleGenerateCharacters = useCallback(async () => {
    if (!currentProjectName || generatingCharacters) return;
    setGeneratingCharacters(true);
    try {
      const result = await API.generateProjectCharacters(currentProjectName);
      await refreshProject();
      const changed = result.added + result.updated;
      useAppStore
        .getState()
        .pushToast(
          changed > 0
            ? tRef.current("characters_generated_toast", { count: changed })
            : tRef.current("characters_generated_no_new"),
          changed > 0 ? "success" : "warning",
        );
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("characters_generate_failed", { message: errMsg(err) }), "error");
    } finally {
      setGeneratingCharacters(false);
    }
  }, [currentProjectName, generatingCharacters, refreshProject]);

  const handleGenerateMissingCharacters = useCallback(async () => {
    if (!currentProjectName || !currentProjectData) return;
    const rawMissingCharacters = Object.entries(currentProjectData.characters ?? {})
      .filter(([, character]) => !character.character_sheet);
    const missingCharacters = rawMissingCharacters.filter(([name]) => !generatingCharacterNames.has(name));
    if (missingCharacters.length === 0) {
      useAppStore
        .getState()
        .pushToast(
          tRef.current(
            rawMissingCharacters.length > 0 ? "character_batch_already_active" : "character_batch_no_missing",
          ),
          "warning",
        );
      return;
    }
    if (!(await ensureGenerationCredits())) return;

    const results = await Promise.allSettled(
      missingCharacters.map(([name, character]) =>
        API.generateCharacter(currentProjectName, name, character.description ?? ""),
      ),
    );
    const submitted = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - submitted;
    if (submitted > 0) {
      useAppStore
        .getState()
        .pushToast(tRef.current("character_batch_submitted_toast", { count: submitted }), "success");
    }
    if (failed > 0) {
      const firstFailure = results.find((result) => result.status === "rejected");
      const message = firstFailure?.status === "rejected" ? errMsg(firstFailure.reason) : "";
      useAppStore
        .getState()
        .pushNotification(
          generationFailureMessage(
            new Error(tRef.current("character_batch_failed", { count: failed, message })),
            "submit_failed",
          ),
          "error",
        );
    }
  }, [
    currentProjectName,
    currentProjectData,
    ensureGenerationCredits,
    generationFailureMessage,
    generatingCharacterNames,
  ]);

  const handleAddCharacterSubmit = useCallback(async (
    name: string,
    description: string,
    voiceStyle: string,
    referenceFile?: File | null,
  ) => {
    if (!currentProjectName) return;
    try {
      await API.addCharacter(currentProjectName, name, description, voiceStyle);

      if (referenceFile) {
        await API.uploadFile(currentProjectName, "character_ref", referenceFile, name);
      }

      await refreshProject(
        referenceFile
          ? [buildEntityRevisionKey("character", name)]
          : [],
      );
      useAppStore.getState().pushToast(tRef.current("character_added_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("add_failed", { message: errMsg(err) }), "error");
      throw err; // AssetFormModal onSubmit 消费：失败时阻止 setAdding(false) 关闭对话框
    }
  }, [currentProjectName, refreshProject]);

  // ---- Scene CRUD callbacks ----
  const handleUpdateScene = useCallback(async (name: string, updates: Partial<Scene>) => {
    if (!currentProjectName) return;
    try {
      await API.updateProjectScene(currentProjectName, name, updates);
      await refreshProject();
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("update_scene_failed", { message: errMsg(err) }), "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleGenerateScene = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    if (generatingSceneNames.has(name)) {
      useAppStore
        .getState()
        .pushToast(tRef.current("scene_task_already_active", { name }), "warning");
      return;
    }
    if (!(await ensureGenerationCredits())) return;
    try {
      await API.generateProjectScene(currentProjectName, name, currentProjectData?.scenes?.[name]?.description ?? "");
      useAppStore.getState().pushToast(tRef.current("scene_task_submitted_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushNotification(generationFailureMessage(err, "submit_failed"), "error");
    }
  }, [
    currentProjectName,
    currentProjectData,
    ensureGenerationCredits,
    generationFailureMessage,
    generatingSceneNames,
  ]);

  const handleGenerateScenes = useCallback(async () => {
    if (!currentProjectName || generatingScenes) return;
    setGeneratingScenes(true);
    try {
      const result = await API.generateProjectScenes(currentProjectName);
      await refreshProject();
      const changed = result.added + result.updated;
      useAppStore
        .getState()
        .pushToast(
          changed > 0
            ? tRef.current("scenes_generated_toast", { count: changed })
            : tRef.current("scenes_generated_no_new"),
          changed > 0 ? "success" : "warning",
        );
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("scenes_generate_failed", { message: errMsg(err) }), "error");
    } finally {
      setGeneratingScenes(false);
    }
  }, [currentProjectName, generatingScenes, refreshProject]);

  const handleGenerateMissingScenes = useCallback(async () => {
    if (!currentProjectName || !currentProjectData) return;
    const rawMissingScenes = Object.entries(currentProjectData.scenes ?? {})
      .filter(([, scene]) => !scene.scene_sheet);
    const missingScenes = rawMissingScenes.filter(([name]) => !generatingSceneNames.has(name));
    if (missingScenes.length === 0) {
      useAppStore
        .getState()
        .pushToast(
          tRef.current(rawMissingScenes.length > 0 ? "scene_batch_already_active" : "scene_batch_no_missing"),
          "warning",
        );
      return;
    }
    if (!(await ensureGenerationCredits())) return;

    const results = await Promise.allSettled(
      missingScenes.map(([name, scene]) =>
        API.generateProjectScene(currentProjectName, name, scene.description ?? ""),
      ),
    );
    const submitted = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - submitted;
    if (submitted > 0) {
      useAppStore
        .getState()
        .pushToast(tRef.current("scene_batch_submitted_toast", { count: submitted }), "success");
    }
    if (failed > 0) {
      const firstFailure = results.find((result) => result.status === "rejected");
      const message = firstFailure?.status === "rejected" ? errMsg(firstFailure.reason) : "";
      useAppStore
        .getState()
        .pushNotification(
          generationFailureMessage(
            new Error(tRef.current("scene_batch_failed", { count: failed, message })),
            "submit_failed",
          ),
          "error",
        );
    }
  }, [
    currentProjectName,
    currentProjectData,
    ensureGenerationCredits,
    generationFailureMessage,
    generatingSceneNames,
  ]);

  const handleAddSceneSubmit = useCallback(async (name: string, description: string) => {
    if (!currentProjectName) return;
    try {
      await API.addProjectScene(currentProjectName, name, description);
      await refreshProject();
      useAppStore.getState().pushToast(tRef.current("scene_added_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("add_failed", { message: errMsg(err) }), "error");
      throw err; // AssetFormModal onSubmit 消费：失败时阻止 setAdding(false) 关闭对话框
    }
  }, [currentProjectName, refreshProject]);

  // ---- Prop CRUD callbacks ----
  const handleUpdateProp = useCallback(async (name: string, updates: Partial<Prop>) => {
    if (!currentProjectName) return;
    try {
      await API.updateProjectProp(currentProjectName, name, updates);
      await refreshProject();
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("update_prop_failed", { message: errMsg(err) }), "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleGenerateProp = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    if (generatingPropNames.has(name)) {
      useAppStore
        .getState()
        .pushToast(tRef.current("prop_task_already_active", { name }), "warning");
      return;
    }
    if (!(await ensureGenerationCredits())) return;
    try {
      await API.generateProjectProp(currentProjectName, name, currentProjectData?.props?.[name]?.description ?? "");
      useAppStore.getState().pushToast(tRef.current("prop_task_submitted_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushNotification(generationFailureMessage(err, "submit_failed"), "error");
    }
  }, [
    currentProjectName,
    currentProjectData,
    ensureGenerationCredits,
    generationFailureMessage,
    generatingPropNames,
  ]);

  const handleGenerateProps = useCallback(async () => {
    if (!currentProjectName || generatingProps) return;
    setGeneratingProps(true);
    try {
      const result = await API.generateProjectProps(currentProjectName);
      await refreshProject();
      const changed = result.added + result.updated;
      useAppStore
        .getState()
        .pushToast(
          changed > 0
            ? tRef.current("props_generated_toast", { count: changed })
            : tRef.current("props_generated_no_new"),
          changed > 0 ? "success" : "warning",
        );
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(tRef.current("props_generate_failed", { message: errMsg(err) }), "error");
    } finally {
      setGeneratingProps(false);
    }
  }, [currentProjectName, generatingProps, refreshProject]);

  const handleGenerateMissingProps = useCallback(async () => {
    if (!currentProjectName || !currentProjectData) return;
    const rawMissingProps = Object.entries(currentProjectData.props ?? {})
      .filter(([, prop]) => !prop.prop_sheet);
    const missingProps = rawMissingProps.filter(([name]) => !generatingPropNames.has(name));
    if (missingProps.length === 0) {
      useAppStore
        .getState()
        .pushToast(
          tRef.current(rawMissingProps.length > 0 ? "prop_batch_already_active" : "prop_batch_no_missing"),
          "warning",
        );
      return;
    }
    if (!(await ensureGenerationCredits())) return;

    const results = await Promise.allSettled(
      missingProps.map(([name, prop]) =>
        API.generateProjectProp(currentProjectName, name, prop.description ?? ""),
      ),
    );
    const submitted = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - submitted;
    if (submitted > 0) {
      useAppStore
        .getState()
        .pushToast(tRef.current("prop_batch_submitted_toast", { count: submitted }), "success");
    }
    if (failed > 0) {
      const firstFailure = results.find((result) => result.status === "rejected");
      const message = firstFailure?.status === "rejected" ? errMsg(firstFailure.reason) : "";
      useAppStore
        .getState()
        .pushNotification(
          generationFailureMessage(
            new Error(tRef.current("prop_batch_failed", { count: failed, message })),
            "submit_failed",
          ),
          "error",
        );
    }
  }, [
    currentProjectName,
    currentProjectData,
    ensureGenerationCredits,
    generationFailureMessage,
    generatingPropNames,
  ]);

  const handleAddPropSubmit = useCallback(async (name: string, description: string) => {
    if (!currentProjectName) return;
    try {
      await API.addProjectProp(currentProjectName, name, description);
      await refreshProject();
      useAppStore.getState().pushToast(tRef.current("prop_added_toast", { name }), "success");
    } catch (err) {
      useAppStore.getState().pushToast(tRef.current("add_failed", { message: errMsg(err) }), "error");
      throw err; // AssetFormModal onSubmit 消费：失败时阻止 setAdding(false) 关闭对话框
    }
  }, [currentProjectName, refreshProject]);

  const handleGenerateGrid = useCallback(async (episode: number, scriptFile: string, sceneIds?: string[]) => {
    if (!currentProjectName) return;
    if (!(await ensureGenerationCredits())) return;
    try {
      const result = await API.generateGrid(currentProjectName, episode, scriptFile, sceneIds);
      useAppStore.getState().pushToast(result.message, "success");
    } catch (err) {
      useAppStore.getState().pushNotification(generationFailureMessage(err, "grid_generation_failed"), "error");
    }
  }, [currentProjectName, ensureGenerationCredits, generationFailureMessage]);

  const handleRestoreAsset = useCallback(async () => {
    await refreshProject();
  }, [refreshProject]);

  const handleGenerateCharacterVoid = useCallback((...args: Parameters<typeof handleGenerateCharacter>) => {
    void handleGenerateCharacter(...args).catch(console.error);
  }, [handleGenerateCharacter]);
  const handleGenerateCharactersVoid = useCallback(() => {
    void handleGenerateCharacters().catch(console.error);
  }, [handleGenerateCharacters]);
  const handleGenerateMissingCharactersVoid = useCallback(() => {
    void handleGenerateMissingCharacters().catch(console.error);
  }, [handleGenerateMissingCharacters]);
  const handleUpdateSceneVoid = useCallback((...args: Parameters<typeof handleUpdateScene>) => {
    void handleUpdateScene(...args).catch(console.error);
  }, [handleUpdateScene]);
  const handleGenerateScenesVoid = useCallback(() => {
    void handleGenerateScenes().catch(console.error);
  }, [handleGenerateScenes]);
  const handleGenerateSceneVoid = useCallback((...args: Parameters<typeof handleGenerateScene>) => {
    void handleGenerateScene(...args).catch(console.error);
  }, [handleGenerateScene]);
  const handleGenerateMissingScenesVoid = useCallback(() => {
    void handleGenerateMissingScenes().catch(console.error);
  }, [handleGenerateMissingScenes]);
  const handleUpdatePropVoid = useCallback((...args: Parameters<typeof handleUpdateProp>) => {
    void handleUpdateProp(...args).catch(console.error);
  }, [handleUpdateProp]);
  const handleGeneratePropsVoid = useCallback(() => {
    void handleGenerateProps().catch(console.error);
  }, [handleGenerateProps]);
  const handleGeneratePropVoid = useCallback((...args: Parameters<typeof handleGenerateProp>) => {
    void handleGenerateProp(...args).catch(console.error);
  }, [handleGenerateProp]);
  const handleGenerateMissingPropsVoid = useCallback(() => {
    void handleGenerateMissingProps().catch(console.error);
  }, [handleGenerateMissingProps]);

  if (!currentProjectName) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        {t("loading_placeholder")}
      </div>
    );
  }

  return (
    <Suspense fallback={<CanvasRouteLoading />}>
      <Switch>
      <Route path="/">
        <OverviewCanvas
          projectName={currentProjectName}
          projectData={currentProjectData}
        />
      </Route>

      <Route path="/lorebook">
        <Redirect to="/characters" />
      </Route>

      <Route path="/clues">
        <Redirect to="/scenes" />
      </Route>

      <Route path="/characters">
        <CharactersPage
          projectName={currentProjectName}
          characters={currentProjectData?.characters ?? {}}
          onSaveCharacter={handleSaveCharacter}
          onGenerateCharacter={handleGenerateCharacterVoid}
          onGenerateCharacters={handleGenerateCharactersVoid}
          onGenerateMissingCharacters={handleGenerateMissingCharactersVoid}
          onAddCharacter={handleAddCharacterSubmit}
          onRestoreCharacterVersion={handleRestoreAsset}
          onRefreshProject={refreshProject}
          generatingCharacters={generatingCharacters}
          generatingCharacterNames={generatingCharacterNames}
        />
      </Route>

      <Route path="/scenes">
        <ScenesPage
          projectName={currentProjectName}
          scenes={currentProjectData?.scenes ?? {}}
          onUpdateScene={handleUpdateSceneVoid}
          onGenerateScenes={handleGenerateScenesVoid}
          onGenerateScene={handleGenerateSceneVoid}
          onGenerateMissingScenes={handleGenerateMissingScenesVoid}
          onAddScene={handleAddSceneSubmit}
          onRestoreSceneVersion={handleRestoreAsset}
          onRefreshProject={refreshProject}
          generatingScenes={generatingScenes}
          generatingSceneNames={generatingSceneNames}
        />
      </Route>

      <Route path="/props">
        <PropsPage
          projectName={currentProjectName}
          props={currentProjectData?.props ?? {}}
          onUpdateProp={handleUpdatePropVoid}
          onGenerateProps={handleGeneratePropsVoid}
          onGenerateProp={handleGeneratePropVoid}
          onGenerateMissingProps={handleGenerateMissingPropsVoid}
          onAddProp={handleAddPropSubmit}
          onRestorePropVersion={handleRestoreAsset}
          onRefreshProject={refreshProject}
          generatingProps={generatingProps}
          generatingPropNames={generatingPropNames}
        />
      </Route>

      <Route path="/settings">
        <ProjectSettingsNestedRedirect projectName={currentProjectName} />
      </Route>

      <Route path="/source/:filename">
        {(params) => (
          <SourceFileViewer
            projectName={currentProjectName}
            filename={decodeURIComponent(params.filename)}
          />
        )}
      </Route>

      <Route path="/episodes/:episodeId">
        {(params) => {
          const epNum = parseInt(params.episodeId, 10);
          const episode = currentProjectData?.episodes?.find((e) => e.episode === epNum);
          const scriptFile = episode?.script_file?.replace(/^scripts\//, "");
          const script = scriptFile ? (currentScripts[scriptFile] ?? null) : null;
          const mode = effectiveMode(currentProjectData, episode);
          const hasDraft =
            episode?.script_status === "segmented" || episode?.script_status === "generated";

          return (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                {mode === "reference_video" ? (
                  <ReferenceVideoCanvas
                    // 同一 epNum 跨项目不 remount 会让 optimisticUnitIds / prevTaskStatusRef
                    // 残留上个项目的状态（例如 "E1U1" 长驻 set 里），切到同名 unit 的新项目
                    // 时 "optimistic && !hasQueueRow" 会误判 busy。改 key 到 project::episode
                    // 让实例天然按项目隔离，避免显式 pruning 逻辑。
                    key={`${currentProjectName}::${epNum}`}
                    projectName={currentProjectName}
                    episode={epNum}
                    episodeTitle={episode?.title}
                  />
                ) : (
                  <TimelineCanvas
                    // 和 ReferenceVideoCanvas (上方) 同理：同 epNum 跨项目不 remount
                    // 会让 TimelineCanvas 内部的 useState / useRef（选中 scene、草稿缓冲、
                    // 滚动位置等）残留上一个项目的值。key 带上 projectName 天然按项目隔离。
                    key={`${currentProjectName}::${epNum}`}
                    projectName={currentProjectName}
                    episode={epNum}
                    episodeTitle={episode?.title}
                    hasDraft={hasDraft}
                    episodeScript={script}
                    scriptFile={scriptFile ?? undefined}
                    projectData={currentProjectData}
                    durationOptions={durationOptions}
                    onUpdatePrompt={voidPromise(handleUpdatePrompt)}
                    onGenerateStoryboard={voidPromise(handleGenerateStoryboard)}
                    onGenerateVideo={voidPromise(handleGenerateVideo)}
                    onGenerateGrid={voidPromise(handleGenerateGrid)}
                    onGenerateEpisodeScript={voidPromise(handleGenerateEpisodeScript)}
                    generatingEpisodeScript={generatingEpisodeScript === epNum}
                    onGenerateEpisodeStoryboards={voidPromise(handleGenerateEpisodeStoryboards)}
                    onGenerateEpisodeVideos={voidPromise(handleGenerateEpisodeVideos)}
                    generatingEpisodeStoryboards={generatingEpisodeStoryboards === epNum}
                    generatingEpisodeVideos={generatingEpisodeVideos === epNum}
                    onRestoreStoryboard={handleRestoreAsset}
                    onRestoreVideo={handleRestoreAsset}
                  />
                )}
              </div>
            </div>
          );
        }}
      </Route>
      </Switch>
    </Suspense>
  );
}
