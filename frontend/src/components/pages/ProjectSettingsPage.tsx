import { useParams, useLocation } from "wouter";
import { errMsg, voidCall, voidPromise } from "@/utils/async";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, CheckCircle2, Coins, ImagePlus, KeyRound, Loader2, LogOut, MapPinned, Trash2, UserPlus, Users, X } from "lucide-react";
import { API, type UserSearchItem } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useProjectsStore } from "@/stores/projects-store";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { PROVIDER_NAMES } from "@/components/ui/ProviderIcon";
import { AuthenticatedImage } from "@/components/ui/AuthenticatedMedia";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { CreateProjectModal } from "./CreateProjectModal";
import { getProviderModels, getCustomProviderModels } from "@/utils/provider-models";
import { ModelConfigSection } from "@/components/shared/ModelConfigSection";
import { StylePicker, type StylePickerValue } from "@/components/shared/StylePicker";
import { CONTENT_TYPE_PRESETS, getContentTypePreset, type ContentTypeId } from "@/data/content-types";
import { DEFAULT_TEMPLATE_ID, getTemplateById } from "@/data/style-templates";
import type { CustomProviderInfo, ProjectMembersResponse, ProviderInfo, TravelRoutePreview, TravelVideoSettings } from "@/types";
import { GenerationModeSelector } from "@/components/shared/GenerationModeSelector";
import { normalizeMode, type GenerationMode } from "@/utils/generation-mode";

function deriveStyleValue(project: Record<string, unknown>, projectName: string): StylePickerValue {
  const styleImage = project.style_image as string | undefined;
  const templateId = (project.style_template_id as string | undefined) ?? null;
  if (styleImage) {
    return {
      mode: "custom",
      templateId: null,
      activeCategory: "content",
      uploadedFile: null,
      uploadedPreview: API.getFileUrl(projectName, styleImage),
    };
  }
  const effectiveId = templateId ?? DEFAULT_TEMPLATE_ID;
  const tpl = getTemplateById(effectiveId);
  return {
    mode: "template",
    templateId: effectiveId,
    activeCategory: tpl?.category ?? "content",
    uploadedFile: null,
    uploadedPreview: null,
  };
}

function normalizeProjectDefaultDuration(project: Record<string, unknown>): number | null {
  const raw = project.default_duration;
  if (raw == null) return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const duration = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(duration)) return null;
  if (project.default_duration_explicit === true) return duration;

  // 旧项目里可能把内容模式的脚本兜底时长写进了项目设置：
  // narration=4s、drama=8s。这不是用户显式偏好，设置页应显示为 auto。
  const contentMode = project.content_mode;
  const implicitDefault =
    contentMode === "narration" ? 4
      : contentMode === "drama" ? 8
        : null;
  return implicitDefault != null && duration === implicitDefault ? null : duration;
}

type TravelVideoSettingsForm = {
  origin: string;
  destination: string;
  route_source: NonNullable<TravelVideoSettings["route_source"]>;
  route_notes: string;
  reference_images: string[];
  narration_language: NonNullable<TravelVideoSettings["narration_language"]>;
  target_duration: NonNullable<TravelVideoSettings["target_duration"]>;
  custom_duration_seconds: number | null;
  camera_style: NonNullable<TravelVideoSettings["camera_style"]>;
  narrator_persona: NonNullable<TravelVideoSettings["narrator_persona"]>;
  character_notes: string;
};

const DEFAULT_TRAVEL_VIDEO_SETTINGS: TravelVideoSettingsForm = {
  origin: "",
  destination: "",
  route_source: "google_street_view",
  route_notes: "",
  reference_images: [],
  narration_language: "zh",
  target_duration: "45s",
  custom_duration_seconds: null,
  camera_style: "street_walk_turns",
  narrator_persona: "enthusiastic_guide",
  character_notes: "",
};

const TRAVEL_ROUTE_SOURCES = ["google_street_view", "baidu_maps", "amap_maps", "manual", "reference_images"] as const;
const MAP_ROUTE_SOURCES = ["google_street_view", "baidu_maps", "amap_maps"] as const;
const TRAVEL_LANGUAGES = ["auto", "zh", "en", "ja"] as const;
const TRAVEL_DURATIONS = ["45s", "60s", "90s", "120s", "150s", "180s", "custom"] as const;
const TRAVEL_CAMERA_STYLES = ["street_walk_turns", "street_drive", "landmark_focus", "cinematic_slow"] as const;
const TRAVEL_NARRATOR_PERSONAS = ["enthusiastic_guide", "local_friend", "documentary", "calm_guide"] as const;
const TRAVEL_REFERENCE_IMAGE_LIMIT = 10;
type MapRouteSource = typeof MAP_ROUTE_SOURCES[number];

function pickOption<T extends readonly string[]>(value: unknown, options: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? value as T[number] : fallback;
}

function parseCustomDurationSeconds(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeTravelVideoSettings(value: unknown): TravelVideoSettingsForm {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const targetDuration = pickOption(raw.target_duration, TRAVEL_DURATIONS, "45s");
  const customDuration = parseCustomDurationSeconds(raw.custom_duration_seconds);
  return {
    origin: typeof raw.origin === "string" ? raw.origin : "",
    destination: typeof raw.destination === "string" ? raw.destination : "",
    route_source: pickOption(raw.route_source, TRAVEL_ROUTE_SOURCES, "google_street_view"),
    route_notes: typeof raw.route_notes === "string" ? raw.route_notes : "",
    reference_images: Array.isArray(raw.reference_images)
      ? raw.reference_images
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, TRAVEL_REFERENCE_IMAGE_LIMIT)
      : [],
    narration_language: pickOption(raw.narration_language, TRAVEL_LANGUAGES, "zh"),
    target_duration: targetDuration,
    custom_duration_seconds: targetDuration === "custom" ? customDuration ?? 120 : customDuration,
    camera_style: pickOption(raw.camera_style, TRAVEL_CAMERA_STYLES, "street_walk_turns"),
    narrator_persona: pickOption(raw.narrator_persona, TRAVEL_NARRATOR_PERSONAS, "enthusiastic_guide"),
    character_notes: typeof raw.character_notes === "string" ? raw.character_notes : "",
  };
}

function serializeTravelVideoSettings(settings: TravelVideoSettings): string {
  return JSON.stringify(normalizeTravelVideoSettings(settings));
}

export function ProjectSettingsPage() {
  const { t } = useTranslation("dashboard");
  const params = useParams<{ projectName: string }>();
  const projectName = params.projectName || "";
  const [, navigate] = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const showCreateModal = useProjectsStore((s) => s.showCreateModal);
  const setShowCreateModal = useProjectsStore((s) => s.setShowCreateModal);

  const [options, setOptions] = useState<{
    video_backends: string[];
    image_backends: string[];
    text_backends: string[];
    provider_names?: Record<string, string>;
  } | null>(null);
  const [globalDefaults, setGlobalDefaults] = useState<{
    video: string;
    image: string;
    textScript: string;
    textOverview: string;
    textStyle: string;
  }>({ video: "", image: "", textScript: "", textOverview: "", textStyle: "" });

  const allProviderNames = useMemo(
    () => ({ ...PROVIDER_NAMES, ...(options?.provider_names ?? {}) }),
    [options],
  );

  // Project-level overrides (from project.json)
  // "" means "follow global default"
  const [videoBackend, setVideoBackend] = useState<string>("");
  const [imageBackend, setImageBackend] = useState<string>("");
  const [audioOverride, setAudioOverride] = useState<boolean | null>(null);
  const [textScript, setTextScript] = useState<string>("");
  const [textOverview, setTextOverview] = useState<string>("");
  const [textStyle, setTextStyle] = useState<string>("");
  const [characterStylePrompt, setCharacterStylePrompt] = useState<string>("");
  const [contentType, setContentType] = useState<ContentTypeId | "">("");
  const [aspectRatio, setAspectRatio] = useState<string>("");
  const [billingMode, setBillingMode] = useState<"byok" | "platform_credits">("byok");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("storyboard");
  const [defaultDuration, setDefaultDuration] = useState<number | null>(null);
  const [travelVideoSettings, setTravelVideoSettings] = useState<TravelVideoSettingsForm>(DEFAULT_TRAVEL_VIDEO_SETTINGS);
  const [mapApiConfigured, setMapApiConfigured] = useState<Record<MapRouteSource, boolean>>({
    google_street_view: false,
    baidu_maps: false,
    amap_maps: false,
  });
  const [uploadingTravelReferences, setUploadingTravelReferences] = useState(false);
  const [travelRoutePreview, setTravelRoutePreview] = useState<TravelRoutePreview | null>(null);
  const [previewingTravelRoute, setPreviewingTravelRoute] = useState(false);
  const [travelRouteThumbnails, setTravelRouteThumbnails] = useState<Record<string, string>>({});
  const [videoResolution, setVideoResolution] = useState<string | null>(null);
  const [imageResolution, setImageResolution] = useState<string | null>(null);
  const [modelSettings, setModelSettings] = useState<Record<string, { resolution: string | null }>>({});
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [minimumGenerationBalance, setMinimumGenerationBalance] = useState(1);
  const [pendingPurchaseCredits, setPendingPurchaseCredits] = useState(0);
  const [reservedGenerationCredits, setReservedGenerationCredits] = useState(0);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProviderInfo[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMembersResponse | null>(null);
  const [memberUserId, setMemberUserId] = useState("");
  const [userSearchResults, setUserSearchResults] = useState<UserSearchItem[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [savingMember, setSavingMember] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Style picker state (independent save flow) ─────────────────────────────
  const [styleValue, setStyleValue] = useState<StylePickerValue | null>(null);
  const [savingStyle, setSavingStyle] = useState(false);
  const initialRef = useRef({
    videoBackend: "", imageBackend: "", audioOverride: null as boolean | null,
    textScript: "", textOverview: "", textStyle: "", characterStylePrompt: "",
    contentType: "" as ContentTypeId | "",
    aspectRatio: "", billingMode: "byok" as "byok" | "platform_credits", generationMode: "storyboard" as GenerationMode,
    defaultDuration: null as number | null,
    travelVideoSettings: serializeTravelVideoSettings(DEFAULT_TRAVEL_VIDEO_SETTINGS),
    videoResolution: null as string | null,
    imageResolution: null as string | null,
  });
  // 风格区独立保存，但"未保存就离开"也需被 isDirty 拦截。
  const initialStyleRef = useRef<StylePickerValue | null>(null);

  useEffect(() => {
    let disposed = false;

    voidCall(Promise.all([
      API.getSystemConfig(),
      API.getProject(projectName),
      getProviderModels().catch(() => [] as ProviderInfo[]),
      getCustomProviderModels().catch(() => [] as CustomProviderInfo[]),
    ]).then(([configRes, projectRes, providerList, customProviderList]) => {
      if (disposed) return;

      setOptions({
        video_backends: configRes.options?.video_backends ?? [],
        image_backends: configRes.options?.image_backends ?? [],
        text_backends: configRes.options?.text_backends ?? [],
        provider_names: configRes.options?.provider_names,
      });
      setGlobalDefaults({
        video: configRes.settings?.default_video_backend ?? "",
        image: configRes.settings?.default_image_backend ?? "",
        textScript: configRes.settings?.text_backend_script ?? "",
        textOverview: configRes.settings?.text_backend_overview ?? "",
        textStyle: configRes.settings?.text_backend_style ?? "",
      });
      setMapApiConfigured({
        google_street_view: Boolean(configRes.settings?.google_maps_api_key?.is_set),
        baidu_maps: Boolean(configRes.settings?.baidu_maps_api_key?.is_set),
        amap_maps: Boolean(configRes.settings?.amap_maps_api_key?.is_set),
      });
      setProviders(providerList);
      setCustomProviders(customProviderList);

      const project = projectRes.project as unknown as Record<string, unknown>;
      const vb = (project.video_backend as string | undefined) ?? "";
      const ib = (project.image_backend as string | undefined) ?? "";
      const rawAudio = project.video_generate_audio;
      const ao = typeof rawAudio === "boolean" ? rawAudio : null;
      const ts = (project.text_backend_script as string | undefined) ?? "";
      const to = (project.text_backend_overview as string | undefined) ?? "";
      const tst = (project.text_backend_style as string | undefined) ?? "";
      const csp = (project.character_style_prompt as string | undefined) ?? "";

      const rawAr = typeof project.aspect_ratio === "string" ? project.aspect_ratio : "";
      // Backend's get_aspect_ratio() falls back to "9:16" when unset (generation_tasks.py).
      // Mirror that here so the UI reflects the actually-effective ratio.
      const ar = rawAr || "9:16";
      const bm = project.billing_mode === "platform_credits" ? "platform_credits" : "byok";
      const gm = normalizeMode(project.generation_mode);
      const dd = normalizeProjectDefaultDuration(project);
      const ct = getContentTypePreset(project.content_type)?.id ?? "";
      const tvs = normalizeTravelVideoSettings(project.travel_video_settings);
      const tvRaw = project.travel_video_settings as TravelVideoSettings | undefined;

      setVideoBackend(vb);
      setImageBackend(ib);
      setAudioOverride(ao);
      setTextScript(ts);
      setTextOverview(to);
      setTextStyle(tst);
      setCharacterStylePrompt(csp);
      setContentType(ct);
      setAspectRatio(ar);
      setBillingMode(bm);
      setGenerationMode(gm);
      setDefaultDuration(dd);
      setTravelVideoSettings(tvs);
      setTravelRoutePreview(tvRaw?.route_preview ?? null);

      // model_settings 的 key 以 effective backend（override ‖ global default）读写，
      // 与 handleSave 保持一致；legacy video_model_settings 作为旧项目兼容回退。
      const defaultVideo = configRes.settings?.default_video_backend ?? "";
      const defaultImage = configRes.settings?.default_image_backend ?? "";
      const effectiveVb = vb || defaultVideo;
      const effectiveIb = ib || defaultImage;
      const ms = (project.model_settings ?? {}) as Record<string, { resolution: string | null }>;
      const legacyVideo = (project.video_model_settings ?? {}) as Record<string, { resolution?: string | null }>;
      const vModelId = effectiveVb && effectiveVb.includes("/") ? effectiveVb.split("/")[1] : effectiveVb;
      const vRes: string | null =
        (effectiveVb ? (ms[effectiveVb]?.resolution ?? null) : null) ||
        (vModelId ? (legacyVideo[vModelId]?.resolution ?? null) : null) ||
        null;
      const iRes = effectiveIb ? (ms[effectiveIb]?.resolution ?? null) : null;
      setVideoResolution(vRes);
      setImageResolution(iRes);
      setModelSettings(ms);

      const derivedStyle = deriveStyleValue(project, projectName);
      setStyleValue(derivedStyle);
      initialStyleRef.current = derivedStyle;
      initialRef.current = {
        videoBackend: vb, imageBackend: ib, audioOverride: ao,
        textScript: ts, textOverview: to, textStyle: tst, characterStylePrompt: csp,
        contentType: ct,
        aspectRatio: ar, billingMode: bm, generationMode: gm, defaultDuration: dd,
        travelVideoSettings: serializeTravelVideoSettings(tvs),
        videoResolution: vRes, imageResolution: iRes,
      };
    }));

    return () => { disposed = true; };
  }, [projectName]);

  useEffect(() => {
    setTravelRouteThumbnails({});
    const nodes = (travelRoutePreview?.nodes ?? []).filter((node) => (
      node.source === "google"
      && node.street_view_status === "OK"
      && Boolean(node.pano_id || (node.lat != null && node.lng != null) || (node.street_view_lat != null && node.street_view_lng != null))
    ));
    if (
      !projectName
      || nodes.length === 0
      || typeof URL === "undefined"
      || typeof URL.createObjectURL !== "function"
    ) {
      return undefined;
    }

    let disposed = false;
    const objectUrls: string[] = [];
    void Promise.all(nodes.map(async (node) => {
      try {
        const blob = await API.fetchTravelRouteStreetView(projectName, node.id);
        if (disposed) return;
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        setTravelRouteThumbnails((current) => ({ ...current, [node.id]: url }));
      } catch {
        // Street View images are optional; metadata and manual references remain usable.
      }
    }));

    return () => {
      disposed = true;
      if (typeof URL.revokeObjectURL === "function") {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
      }
    };
  }, [projectName, travelRoutePreview]);

  useEffect(() => {
    let disposed = false;
    API.getProjectMembers(projectName)
      .then((res) => {
        if (!disposed) setProjectMembers(res);
      })
      .catch(() => {
        if (!disposed) setProjectMembers(null);
      });
    return () => {
      disposed = true;
    };
  }, [projectName]);

  // blob: URL 所有权集中：StylePicker 只通过 onChange 更换引用，
  // revoke 统一在此 effect 做（URL 变更或卸载时）。
  useEffect(() => {
    const url = styleValue?.uploadedPreview;
    if (!url?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(url);
  }, [styleValue?.uploadedPreview]);

  const styleIsDirty = (() => {
    const init = initialStyleRef.current;
    if (!styleValue || !init) return false;
    if (styleValue.mode !== init.mode) return true;
    if (styleValue.mode === "template") return styleValue.templateId !== init.templateId;
    // custom 模式：新上传文件、或既有图被用户清空（preview 从 URL 变为 null）
    return styleValue.uploadedFile !== null || styleValue.uploadedPreview !== init.uploadedPreview;
  })();

  // "无风格"态：模版未选 + 未上传新文件 + 未保留旧预览
  const isStyleCleared = !!styleValue
    && styleValue.templateId === null
    && styleValue.uploadedFile === null
    && !styleValue.uploadedPreview;
  const hasInitialStyle = !!initialStyleRef.current
    && (initialStyleRef.current.templateId !== null
      || initialStyleRef.current.uploadedPreview !== null);

  const isDirty =
    videoBackend !== initialRef.current.videoBackend ||
    imageBackend !== initialRef.current.imageBackend ||
    audioOverride !== initialRef.current.audioOverride ||
    textScript !== initialRef.current.textScript ||
    textOverview !== initialRef.current.textOverview ||
    textStyle !== initialRef.current.textStyle ||
    characterStylePrompt !== initialRef.current.characterStylePrompt ||
    contentType !== initialRef.current.contentType ||
    aspectRatio !== initialRef.current.aspectRatio ||
    billingMode !== initialRef.current.billingMode ||
    generationMode !== initialRef.current.generationMode ||
    defaultDuration !== initialRef.current.defaultDuration ||
    serializeTravelVideoSettings(travelVideoSettings) !== initialRef.current.travelVideoSettings ||
    videoResolution !== initialRef.current.videoResolution ||
    imageResolution !== initialRef.current.imageResolution ||
    styleIsDirty;

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    let disposed = false;
    if (billingMode !== "platform_credits") {
      setCreditBalance(null);
      setMinimumGenerationBalance(1);
      setPendingPurchaseCredits(0);
      setReservedGenerationCredits(0);
      return () => {
        disposed = true;
      };
    }
    API.getCreditBalance()
      .then((res) => {
        if (!disposed) {
          setCreditBalance(res.available_balance ?? res.balance);
          setMinimumGenerationBalance(res.minimum_generation_balance);
          setPendingPurchaseCredits(res.pending_purchase_credits);
          setReservedGenerationCredits(res.reserved_generation_credits ?? 0);
        }
      })
      .catch(() => {
        if (!disposed) {
          setCreditBalance(null);
          setMinimumGenerationBalance(1);
          setPendingPurchaseCredits(0);
          setReservedGenerationCredits(0);
        }
      });
    return () => {
      disposed = true;
    };
  }, [billingMode]);

  const guardedNavigate = useCallback((path: string) => {
    if (isDirty && !window.confirm(t("unsaved_changes_confirm"))) return;
    navigate(path);
  }, [isDirty, navigate, t]);

  // Cross-tab switch from custom → template may leave {mode:"template", templateId:null}
  // while an uploaded preview still lingers — no user-chosen card. Block save so
  // clicking it can't silently route to the "clear style" PATCH branch. The
  // explicit 取消风格 action zeroes uploadedFile/uploadedPreview too, bypassing this.
  const isStyleIncomplete =
    !!styleValue
    && styleValue.mode === "template"
    && !styleValue.templateId
    && (styleValue.uploadedFile !== null || !!styleValue.uploadedPreview);
  const isStyleSaveDisabled = savingStyle || !styleIsDirty || isStyleIncomplete;
  const isCreditBalanceLow =
    billingMode === "platform_credits" && creditBalance !== null && creditBalance < minimumGenerationBalance;
  const canManageMembers = projectMembers?.current_user_role === "owner";
  const selectedContentTypePreset = getContentTypePreset(contentType);
  const showTravelVideoSettings = contentType === "travel_video";

  useEffect(() => {
    let disposed = false;
    const query = memberUserId.trim();
    if (!canManageMembers || query.length < 2) {
      setUserSearchResults([]);
      setSearchingUsers(false);
      return () => {
        disposed = true;
      };
    }
    setSearchingUsers(true);
    const timer = window.setTimeout(() => {
      API.searchUsers(query)
        .then((users) => {
          if (!disposed) setUserSearchResults(users);
        })
        .catch(() => {
          if (!disposed) setUserSearchResults([]);
        })
        .finally(() => {
          if (!disposed) setSearchingUsers(false);
        });
    }, 200);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [canManageMembers, memberUserId]);

  const handleAddMember = useCallback(async () => {
    const identifier = memberUserId.trim();
    if (!identifier) return;
    setSavingMember(true);
    try {
      const next = await API.addProjectMember(projectName, identifier, "editor");
      setProjectMembers(next);
      setMemberUserId("");
      setUserSearchResults([]);
      useAppStore.getState().pushToast(t("project_member_added"), "success");
    } catch (e: unknown) {
      useAppStore.getState().pushToast(t("project_member_add_failed", { message: errMsg(e) }), "error");
    } finally {
      setSavingMember(false);
    }
  }, [memberUserId, projectName, t]);

  const handleRemoveMember = useCallback(async (userId: string) => {
    setSavingMember(true);
    try {
      const next = await API.deleteProjectMember(projectName, userId);
      setProjectMembers(next);
      useAppStore.getState().pushToast(t("project_member_removed"), "success");
    } catch (e: unknown) {
      useAppStore.getState().pushToast(t("project_member_remove_failed", { message: errMsg(e) }), "error");
    } finally {
      setSavingMember(false);
    }
  }, [projectName, t]);

  const handleSaveStyle = useCallback(async () => {
    if (!styleValue) return;
    setSavingStyle(true);
    try {
      if (styleValue.mode === "template" && styleValue.templateId) {
        await API.updateProject(projectName, { style_template_id: styleValue.templateId });
      } else if (styleValue.mode === "custom" && styleValue.uploadedFile) {
        await API.uploadStyleImage(projectName, styleValue.uploadedFile);
      } else {
        // 取消风格：显式清掉模板 ID 与自定义图
        await API.updateProject(projectName, {
          style_template_id: null,
          clear_style_image: true,
        });
      }
      // Refetch project to reset styleValue from canonical server state
      const refreshed = await API.getProject(projectName);
      const nextStyle = deriveStyleValue(refreshed.project as unknown as Record<string, unknown>, projectName);
      setStyleValue(nextStyle);
      initialStyleRef.current = nextStyle;
      useAppStore.getState().pushToast(t("saved"), "success");
    } catch (e: unknown) {
      useAppStore.getState().pushToast(t("save_failed", { message: errMsg(e) }), "error");
    } finally {
      setSavingStyle(false);
    }
  }, [styleValue, projectName, t]);

  const handleClearStyle = useCallback(() => {
    if (!styleValue) return;
    setStyleValue({
      ...styleValue,
      templateId: null,
      uploadedFile: null,
      uploadedPreview: null,
    });
  }, [styleValue]);

  const handleLogout = useCallback(() => {
    logout();
    navigate("/login");
  }, [logout, navigate]);

  const updateTravelVideoSetting = useCallback((key: keyof TravelVideoSettingsForm, value: string) => {
    setTravelRoutePreview(null);
    setTravelVideoSettings((prev) => normalizeTravelVideoSettings({ ...prev, [key]: value }));
  }, []);

  const handleUploadTravelReferences = useCallback(async (files: FileList | null) => {
    const incoming = Array.from(files ?? []).filter((file) => file.size > 0);
    const remaining = Math.max(0, TRAVEL_REFERENCE_IMAGE_LIMIT - travelVideoSettings.reference_images.length);
    if (incoming.length > remaining) {
      useAppStore.getState().pushToast(t("travel_video_reference_upload_limit", { limit: TRAVEL_REFERENCE_IMAGE_LIMIT }), "warning");
    }
    const selected = incoming.slice(0, remaining);
    if (selected.length === 0) return;
    setUploadingTravelReferences(true);
    try {
      const uploaded = await Promise.all(
        selected.map((file) => API.uploadFile(projectName, "travel_reference", file)),
      );
      const paths = uploaded.map((item) => item.path).filter(Boolean);
      setTravelRoutePreview(null);
      setTravelVideoSettings((prev) => normalizeTravelVideoSettings({
        ...prev,
        reference_images: [...prev.reference_images, ...paths],
      }));
      useAppStore.getState().pushToast(t("travel_video_reference_upload_success", { count: paths.length }), "success");
    } catch (e: unknown) {
      useAppStore.getState().pushToast(t("travel_video_reference_upload_failed", { message: errMsg(e) }), "error");
    } finally {
      setUploadingTravelReferences(false);
    }
  }, [projectName, t, travelVideoSettings.reference_images.length]);

  const handleRemoveTravelReference = useCallback((path: string) => {
    setTravelRoutePreview(null);
    setTravelVideoSettings((prev) => normalizeTravelVideoSettings({
      ...prev,
      reference_images: prev.reference_images.filter((item) => item !== path),
    }));
  }, []);

  const handlePreviewTravelRoute = useCallback(async () => {
    setPreviewingTravelRoute(true);
    try {
      const preview = await API.previewTravelRoute(projectName, normalizeTravelVideoSettings(travelVideoSettings));
      setTravelRoutePreview(preview);
      useAppStore.getState().pushToast(
        preview.route_ready ? t("travel_route_preview_success") : t("travel_route_preview_incomplete"),
        preview.route_ready ? "success" : "warning",
      );
    } catch (e: unknown) {
      useAppStore.getState().pushToast(t("travel_route_preview_failed", { message: errMsg(e) }), "error");
    } finally {
      setPreviewingTravelRoute(false);
    }
  }, [projectName, t, travelVideoSettings]);

  const handleContentTypeChange = useCallback((next: ContentTypeId) => {
    const preset = getContentTypePreset(next);
    setContentType(next);
    if (!preset) return;
    setAspectRatio(preset.aspectRatio);
    setGenerationMode(preset.generationMode);
    if (next === "travel_video") {
      setTravelVideoSettings((prev) => normalizeTravelVideoSettings(prev));
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // resolution 的 key 用 effective backend（override ‖ global default），
      // 否则“跟随全局默认”路径下用户选的分辨率不会被写入。
      const effectiveVideo = videoBackend || globalDefaults.video || "";
      const effectiveImage = imageBackend || globalDefaults.image || "";
      const newModelSettings: Record<string, { resolution: string | null }> = { ...modelSettings };
      if (effectiveVideo) {
        newModelSettings[effectiveVideo] = { resolution: videoResolution };
      }
      if (effectiveImage) {
        newModelSettings[effectiveImage] = { resolution: imageResolution };
      }
      const trimmedCharacterStyle = characterStylePrompt.trim();
      const savedTravelVideoSettings = showTravelVideoSettings
        ? normalizeTravelVideoSettings(travelVideoSettings)
        : DEFAULT_TRAVEL_VIDEO_SETTINGS;
      const savedTravelVideoPayload: TravelVideoSettings = travelRoutePreview
        ? { ...savedTravelVideoSettings, route_preview: travelRoutePreview }
        : savedTravelVideoSettings;

      const updates: Record<string, unknown> = {
        video_backend: videoBackend || null,
        image_backend: imageBackend || null,
        video_generate_audio: audioOverride,
        text_backend_script: textScript || null,
        text_backend_overview: textOverview || null,
        text_backend_style: textStyle || null,
        character_style_prompt: trimmedCharacterStyle || null,
        aspect_ratio: aspectRatio || undefined,
        billing_mode: billingMode,
        generation_mode: generationMode,
        default_duration: defaultDuration,
        model_settings: newModelSettings,
      };
      if (contentType || initialRef.current.contentType) {
        updates.content_type = contentType || null;
      }
      if (showTravelVideoSettings || initialRef.current.travelVideoSettings !== serializeTravelVideoSettings(DEFAULT_TRAVEL_VIDEO_SETTINGS)) {
        updates.travel_video_settings = showTravelVideoSettings ? savedTravelVideoPayload : null;
      }

      await API.updateProject(projectName, updates);
      setModelSettings(newModelSettings);
      setCharacterStylePrompt(trimmedCharacterStyle);
      setTravelVideoSettings(savedTravelVideoSettings);
      initialRef.current = {
        videoBackend, imageBackend, audioOverride,
        textScript, textOverview, textStyle, characterStylePrompt: trimmedCharacterStyle,
        contentType,
        aspectRatio, billingMode, generationMode, defaultDuration,
        travelVideoSettings: serializeTravelVideoSettings(savedTravelVideoSettings),
        videoResolution, imageResolution,
      };
      useAppStore.getState().pushToast(t("saved"), "success");
    } catch (e: unknown) {
      useAppStore.getState().pushToast(t("save_failed", { message: errMsg(e) }), "error");
    } finally {
      setSaving(false);
    }
  }, [modelSettings, videoBackend, imageBackend, audioOverride, textScript, textOverview, textStyle, characterStylePrompt, contentType, aspectRatio, billingMode, generationMode, defaultDuration, travelVideoSettings, travelRoutePreview, showTravelVideoSettings, videoResolution, imageResolution, projectName, t, globalDefaults.video, globalDefaults.image]);

  const selectedMapRouteSource = MAP_ROUTE_SOURCES.includes(travelVideoSettings.route_source as MapRouteSource)
    ? travelVideoSettings.route_source as MapRouteSource
    : null;
  const selectedMapApiConfigured = selectedMapRouteSource ? mapApiConfigured[selectedMapRouteSource] : false;
  const selectedMapProviderLabel = selectedMapRouteSource ? t(`travel_video_route_source_${selectedMapRouteSource}`) : "";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-950">
      {/* Header */}
      <div className="z-10 shrink-0 border-b border-gray-800 bg-gray-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => guardedNavigate(`/app/projects/${projectName}`)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200 focus-ring"
              aria-label={t("back_to_project")}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="text-lg font-semibold text-gray-100">{t("project_settings")}</h1>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
              title={t("common:logout")}
              aria-label={t("common:logout")}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1">
        <AppSidebar
          responsive={false}
          onNavigate={guardedNavigate}
          onImportZip={() => guardedNavigate("/app/projects?importZip=1")}
          onCreateProject={() => setShowCreateModal(true)}
        />
        <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">{t("model_config")}</h2>
          <p className="mt-1 text-sm text-gray-500">
            {t("model_config_project_desc")}
          </p>
        </div>

        {/* Content type */}
        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <fieldset>
            <legend className="text-sm font-medium text-gray-100">{t("content_type")}</legend>
            <p className="mt-1 text-sm text-gray-500">{t("project_content_type_desc")}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {CONTENT_TYPE_PRESETS.map((preset) => {
                const selected = contentType === preset.id;
                return (
                  <label
                    key={preset.id}
                    aria-label={t(preset.labelKey)}
                    className={`cursor-pointer rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${
                      selected
                        ? "border-indigo-400 bg-indigo-500/10 text-indigo-100"
                        : "border-gray-800 bg-gray-900/60 text-gray-300 hover:border-gray-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name="contentType"
                      value={preset.id}
                      checked={selected}
                      onChange={() => handleContentTypeChange(preset.id)}
                      className="sr-only"
                    />
                    <span className="block text-sm font-medium">{t(preset.labelKey)}</span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500">
                      {t(preset.descriptionKey)}
                    </span>
                  </label>
                );
              })}
            </div>
            {selectedContentTypePreset ? (
              <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-300">
                    {selectedContentTypePreset.contentMode === "narration" ? t("narration_visuals") : t("drama_animation")}
                  </span>
                  <span className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-300">
                    {selectedContentTypePreset.aspectRatio === "9:16" ? t("portrait_9_16") : t("landscape_16_9")}
                  </span>
                  <span className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-300">
                    {t(`mode_${selectedContentTypePreset.generationMode}`)}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-gray-400">
                  {t(selectedContentTypePreset.workflowGoalKey)}
                </p>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-gray-800 px-3 py-2 text-sm text-gray-500">
                {t("project_content_type_unset_hint")}
              </p>
            )}
          </fieldset>
        </div>

        {showTravelVideoSettings && (
          <section className="rounded-xl border border-indigo-400/25 bg-indigo-500/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-gray-100">{t("travel_video_settings_title")}</h2>
                <p className="mt-1 text-sm leading-6 text-gray-500">{t("travel_video_settings_desc")}</p>
              </div>
              <span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-xs font-medium text-emerald-200">
                {t("travel_video_ready_badge")}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_origin")}</span>
                <input
                  value={travelVideoSettings.origin}
                  onChange={(event) => updateTravelVideoSetting("origin", event.target.value)}
                  placeholder={t("travel_video_origin_placeholder")}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_destination")}</span>
                <input
                  value={travelVideoSettings.destination}
                  onChange={(event) => updateTravelVideoSetting("destination", event.target.value)}
                  placeholder={t("travel_video_destination_placeholder")}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_route_source")}</span>
                <select
                  value={travelVideoSettings.route_source}
                  onChange={(event) => updateTravelVideoSetting("route_source", event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
                >
                  {TRAVEL_ROUTE_SOURCES.map((source) => (
                    <option key={source} value={source}>{t(`travel_video_route_source_${source}`)}</option>
                  ))}
                </select>
              </label>
              {selectedMapRouteSource && (
                <div className={`rounded-lg border px-3 py-2 text-xs leading-5 sm:col-span-2 ${
                  selectedMapApiConfigured
                    ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
                    : "border-amber-300/25 bg-amber-300/10 text-amber-100"
                }`}>
                  <div className="font-medium">
                    {selectedMapApiConfigured
                      ? t("maps_api_configured", { provider: selectedMapProviderLabel })
                      : t("maps_api_optional_missing", { provider: selectedMapProviderLabel })}
                  </div>
                  <div className="mt-1 opacity-80">
                    {selectedMapApiConfigured
                      ? t("maps_api_configured_desc")
                      : t("maps_api_optional_missing_desc")}
                  </div>
                  {!selectedMapApiConfigured && (
                    <button
                      type="button"
                      onClick={() => guardedNavigate("/app/settings?section=maps")}
                      className="mt-2 inline-flex items-center rounded-md border border-amber-200/30 px-2 py-1 font-medium transition-colors hover:bg-amber-200/10"
                    >
                      {t("maps_open_settings")}
                    </button>
                  )}
                </div>
              )}
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_language")}</span>
                <select
                  value={travelVideoSettings.narration_language}
                  onChange={(event) => updateTravelVideoSetting("narration_language", event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
                >
                  {TRAVEL_LANGUAGES.map((language) => (
                    <option key={language} value={language}>{t(`travel_video_language_${language}`)}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_target_duration")}</span>
                <select
                  value={travelVideoSettings.target_duration}
                  onChange={(event) => updateTravelVideoSetting("target_duration", event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
                >
                  {TRAVEL_DURATIONS.map((duration) => (
                    <option key={duration} value={duration}>{t(`travel_video_duration_${duration}`)}</option>
                  ))}
                </select>
              </label>
              {travelVideoSettings.target_duration === "custom" && (
                <label className="block">
                  <span className="text-xs font-medium text-gray-400">{t("travel_video_custom_duration_seconds")}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={travelVideoSettings.custom_duration_seconds ?? ""}
                    onChange={(event) => {
                      setTravelRoutePreview(null);
                      setTravelVideoSettings((prev) => normalizeTravelVideoSettings({
                        ...prev,
                        target_duration: "custom",
                        custom_duration_seconds: event.target.value,
                      }));
                    }}
                    placeholder={t("travel_video_custom_duration_placeholder")}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
                  />
                  <span className="mt-1 block text-xs text-gray-500">{t("travel_video_custom_duration_hint")}</span>
                </label>
              )}
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_camera_style")}</span>
                <select
                  value={travelVideoSettings.camera_style}
                  onChange={(event) => updateTravelVideoSetting("camera_style", event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
                >
                  {TRAVEL_CAMERA_STYLES.map((style) => (
                    <option key={style} value={style}>{t(`travel_video_camera_style_${style}`)}</option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium text-gray-400">{t("travel_video_narrator_persona")}</span>
                <select
                  value={travelVideoSettings.narrator_persona}
                  onChange={(event) => updateTravelVideoSetting("narrator_persona", event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
                >
                  {TRAVEL_NARRATOR_PERSONAS.map((persona) => (
                    <option key={persona} value={persona}>{t(`travel_video_narrator_${persona}`)}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="mt-3 block">
              <span className="text-xs font-medium text-gray-400">{t("travel_video_route_notes")}</span>
              <textarea
                value={travelVideoSettings.route_notes}
                onChange={(event) => updateTravelVideoSetting("route_notes", event.target.value)}
                rows={4}
                placeholder={t("travel_video_route_notes_placeholder")}
                className="mt-1 w-full resize-y rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm leading-6 text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
              />
              <span className="mt-1 block text-xs text-gray-500">{t("travel_video_route_notes_hint")}</span>
            </label>

            <div className="mt-3 rounded-lg border border-cyan-300/20 bg-cyan-400/5 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-cyan-100">
                    <MapPinned className="h-4 w-4" />
                    {t("travel_route_preview_title")}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-cyan-100/65">{t("travel_route_preview_desc")}</p>
                </div>
                <button
                  type="button"
                  onClick={voidPromise(handlePreviewTravelRoute)}
                  disabled={previewingTravelRoute}
                  className="inline-flex items-center gap-1.5 rounded-md border border-cyan-300/25 bg-cyan-300/10 px-3 py-1.5 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-300/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {previewingTravelRoute ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPinned className="h-3.5 w-3.5" />}
                  {previewingTravelRoute ? t("travel_route_preview_running") : t("travel_route_preview_action")}
                </button>
              </div>

              {travelRoutePreview && (
                <div className="mt-3 space-y-3">
                  <div className={`rounded-lg border px-3 py-2 text-xs leading-5 ${
                    travelRoutePreview.route_ready
                      ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
                      : "border-amber-300/25 bg-amber-300/10 text-amber-100"
                  }`}>
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {travelRoutePreview.route_ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                      <span>{travelRoutePreview.route_ready ? t("travel_route_preview_ready") : t("travel_route_preview_not_ready")}</span>
                      <span className="rounded bg-black/20 px-1.5 py-0.5">
                        {t(`travel_route_preview_source_${travelRoutePreview.source}`)}
                      </span>
                    </div>
                    <div className="mt-1 opacity-80">
                      {travelRoutePreview.summary || t("travel_route_preview_no_summary")}
                      {(travelRoutePreview.distance_text || travelRoutePreview.duration_text) && (
                        <span>
                          {" · "}
                          {travelRoutePreview.distance_text || t("travel_route_preview_unknown_distance")}
                          {" / "}
                          {travelRoutePreview.duration_text || t("travel_route_preview_unknown_duration")}
                        </span>
                      )}
                    </div>
                  </div>

                  {travelRoutePreview.warnings.length > 0 && (
                    <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">
                      {travelRoutePreview.warnings.map((warning) => (
                        <div key={warning.code}>{warning.message}</div>
                      ))}
                    </div>
                  )}

                  {travelRoutePreview.nodes.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {travelRoutePreview.nodes.slice(0, 8).map((node) => {
                        const referenceThumbnailUrl = node.source === "reference_image" && node.instruction
                          ? API.getFileUrl(projectName, node.instruction)
                          : null;
                        const thumbnailUrl = travelRouteThumbnails[node.id] ?? referenceThumbnailUrl;
                        const thumbnailAlt = node.source === "reference_image"
                          ? t("travel_video_reference_image_alt")
                          : t("travel_route_preview_street_view_alt");
                        return (
                          <div key={node.id} className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
                            {thumbnailUrl && (
                              <div className="mb-2 aspect-video overflow-hidden rounded-md border border-cyan-300/15 bg-gray-900">
                                <AuthenticatedImage
                                  src={thumbnailUrl}
                                  alt={`${thumbnailAlt} ${node.label}`}
                                  className="h-full w-full object-cover"
                                />
                              </div>
                            )}
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-xs font-medium text-gray-200">{node.label}</span>
                              {node.street_view_status && (
                                <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                                  {node.street_view_status}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                              {node.instruction || t("travel_route_preview_node_empty")}
                            </p>
                            {(node.distance_text || node.duration_text || node.lat != null) && (
                              <p className="mt-1 truncate font-mono text-[11px] text-gray-600">
                                {[node.distance_text, node.duration_text, node.lat != null && node.lng != null ? `${node.lat}, ${node.lng}` : ""]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-gray-300">{t("travel_video_reference_images")}</div>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{t("travel_video_reference_images_hint")}</p>
                  <p className="mt-1 text-xs leading-5 text-cyan-100/65">
                    {t("travel_video_reference_images_rule", {
                      count: travelVideoSettings.reference_images.length,
                      limit: TRAVEL_REFERENCE_IMAGE_LIMIT,
                    })}
                  </p>
                </div>
                <label className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  travelVideoSettings.reference_images.length >= TRAVEL_REFERENCE_IMAGE_LIMIT
                    ? "cursor-not-allowed border-gray-800 bg-gray-900/50 text-gray-500"
                    : "cursor-pointer border-gray-700 bg-gray-900 text-gray-200 hover:border-indigo-400/50 hover:bg-indigo-500/10"
                }`}>
                  {uploadingTravelReferences ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImagePlus className="h-3.5 w-3.5" />
                  )}
                  {uploadingTravelReferences ? t("travel_video_reference_uploading") : t("travel_video_reference_upload")}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    disabled={uploadingTravelReferences || travelVideoSettings.reference_images.length >= TRAVEL_REFERENCE_IMAGE_LIMIT}
                    className="sr-only"
                    aria-label={t("travel_video_reference_upload")}
                    onChange={(event) => {
                      void handleUploadTravelReferences(event.currentTarget.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>

              {travelVideoSettings.reference_images.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {travelVideoSettings.reference_images.map((path) => (
                    <div key={path} className="group relative overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
                      <AuthenticatedImage
                        src={API.getFileUrl(projectName, path)}
                        alt={t("travel_video_reference_image_alt")}
                        className="aspect-video w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveTravelReference(path)}
                        aria-label={t("travel_video_reference_remove")}
                        className="absolute right-1 top-1 rounded-md bg-gray-950/80 p-1 text-gray-300 opacity-90 transition-colors hover:bg-red-500/90 hover:text-white"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500">
                  {t("travel_video_reference_images_empty")}
                </div>
              )}
            </div>

            <label className="mt-3 block">
              <span className="text-xs font-medium text-gray-400">{t("travel_video_character_notes")}</span>
              <textarea
                value={travelVideoSettings.character_notes}
                onChange={(event) => updateTravelVideoSetting("character_notes", event.target.value)}
                rows={3}
                placeholder={t("travel_video_character_notes_placeholder")}
                className="mt-1 w-full resize-y rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm leading-6 text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
              />
            </label>
          </section>
        )}

        {/* Billing mode */}
        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <fieldset>
            <legend className="text-sm font-medium text-gray-100">{t("billing_mode")}</legend>
            <p className="mt-1 text-sm text-gray-500">{t("project_billing_mode_desc")}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {([
                {
                  value: "byok",
                  label: t("billing_mode_byok"),
                  description: t("billing_mode_byok_desc"),
                  Icon: KeyRound,
                },
                {
                  value: "platform_credits",
                  label: t("billing_mode_platform"),
                  description: t("billing_mode_platform_desc"),
                  Icon: Coins,
                },
              ] as const).map(({ value, label, description, Icon }) => {
                const selected = billingMode === value;
                return (
                  <label
                    key={value}
                    aria-label={label}
                    className={`cursor-pointer rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${
                      selected
                        ? "border-indigo-400 bg-indigo-500/10 text-indigo-100"
                        : "border-gray-800 bg-gray-900/60 text-gray-300 hover:border-gray-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name="billingMode"
                      value={value}
                      checked={selected}
                      onChange={() => setBillingMode(value)}
                      className="sr-only"
                    />
                    <span className="flex items-start gap-3">
                      <span className={`mt-0.5 rounded-md p-1.5 ${selected ? "bg-indigo-400/15 text-indigo-200" : "bg-gray-800 text-gray-400"}`}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span>
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="mt-1 block text-xs leading-5 text-gray-500">{description}</span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {billingMode === "platform_credits" && (
              <div
                className={`mt-3 flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between ${
                  isCreditBalanceLow
                    ? "border-red-300/25 bg-red-400/10 text-red-100"
                    : "border-amber-300/20 bg-amber-300/5 text-amber-100"
                }`}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-center gap-1.5">
                    {isCreditBalanceLow ? (
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                    ) : (
                      <Coins className="h-4 w-4 shrink-0" />
                    )}
                    {t("credit_balance", {
                      count: creditBalance == null ? "—" : creditBalance.toLocaleString(),
                    })}
                  </span>
                  <span className={`text-xs ${isCreditBalanceLow ? "text-red-100/80" : "text-amber-100/70"}`}>
                    {isCreditBalanceLow
                      ? t("credit_low_balance_hint", { count: minimumGenerationBalance.toLocaleString() })
                      : t("credit_min_generation", { count: minimumGenerationBalance.toLocaleString() })}
                  </span>
                  {pendingPurchaseCredits > 0 && (
                    <span className="text-xs text-amber-100/70">
                      {t("credit_pending_purchase", { count: pendingPurchaseCredits.toLocaleString() })}
                    </span>
                  )}
                  {reservedGenerationCredits > 0 && (
                    <span className="text-xs text-sky-100/75">
                      {t("credit_reserved_generation", { count: reservedGenerationCredits.toLocaleString() })}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => guardedNavigate("/app/projects?buyCredits=1")}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-300/30 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-amber-300/10"
                >
                  <Coins className="h-3.5 w-3.5" />
                  {t("buy_credits")}
                </button>
              </div>
            )}
          </fieldset>
        </div>

        {/* Style picker (independent save flow, mutually exclusive template / custom) */}
        {styleValue && (
          <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4 space-y-3">
            <div className="text-sm font-medium text-gray-100">{t("project_style_section_title")}</div>
            <StylePicker value={styleValue} onChange={setStyleValue} />
            <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
              <button
                type="button"
                onClick={voidPromise(handleSaveStyle)}
                disabled={isStyleSaveDisabled}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
              >
                {savingStyle && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                {savingStyle ? t("style_saving") : t("style_save")}
              </button>
              {hasInitialStyle && !isStyleCleared && !savingStyle && (
                <button
                  type="button"
                  onClick={handleClearStyle}
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 rounded"
                >
                  {t("style_clear")}
                </button>
              )}
              {isStyleCleared && !savingStyle && styleIsDirty && (
                <p className="text-xs text-gray-500">{t("style_cleared_hint")}</p>
              )}
            </div>
          </div>
        )}

        {/* Character design style */}
        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-100">{t("character_style_prompt")}</span>
            <span className="mt-1 block text-sm text-gray-500">{t("character_style_prompt_desc")}</span>
            <textarea
              value={characterStylePrompt}
              onChange={(event) => setCharacterStylePrompt(event.target.value)}
              rows={4}
              className="mt-3 w-full resize-y rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm leading-6 text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
              placeholder={t("character_style_prompt_placeholder")}
            />
          </label>
        </div>

        {options && (
          <>
            {/* Model config (video + duration + image + text) */}
            <ModelConfigSection
              value={{
                videoBackend,
                imageBackend,
                textBackendScript: textScript,
                textBackendOverview: textOverview,
                textBackendStyle: textStyle,
                defaultDuration,
                videoResolution,
                imageResolution,
              }}
              onChange={(next) => {
                setVideoBackend(next.videoBackend);
                setImageBackend(next.imageBackend);
                setTextScript(next.textBackendScript);
                setTextOverview(next.textBackendOverview);
                setTextStyle(next.textBackendStyle);
                setDefaultDuration(next.defaultDuration);
                setVideoResolution(next.videoResolution);
                setImageResolution(next.imageResolution);
              }}
              providers={providers}
              customProviders={customProviders}
              options={{
                videoBackends: options.video_backends,
                imageBackends: options.image_backends,
                textBackends: options.text_backends,
                providerNames: allProviderNames,
              }}
              globalDefaults={{
                video: globalDefaults.video,
                image: globalDefaults.image,
                textScript: globalDefaults.textScript ?? "",
                textOverview: globalDefaults.textOverview ?? "",
                textStyle: globalDefaults.textStyle ?? "",
              }}
            />

            {/* Aspect ratio */}
            <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
              <fieldset>
                <legend className="mb-3 text-sm font-medium text-gray-100">{t("aspect_ratio_label")}</legend>
                <div className="flex gap-3">
                  {(["9:16", "16:9"] as const).map((ar) => (
                    <label
                      key={ar}
                      className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${
                        aspectRatio === ar
                          ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
                          : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                      }`}
                    >
                      <input
                        type="radio"
                        name="aspectRatio"
                        value={ar}
                        checked={aspectRatio === ar}
                        onChange={() => {
                          setAspectRatio(ar);
                          if (initialRef.current.aspectRatio && ar !== initialRef.current.aspectRatio) {
                            useAppStore.getState().pushToast(
                              t("aspect_ratio_change_warning"),
                              "warning",
                            );
                          }
                        }}
                        className="sr-only"
                      />
                      {ar === "9:16" ? t("portrait_9_16") : t("landscape_16_9")}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            {/* Generation mode */}
            <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-gray-100">{t("generation_mode")}</legend>
                <GenerationModeSelector
                  value={generationMode}
                  onChange={setGenerationMode}
                />
              </fieldset>
            </div>

            {/* Audio override */}
            <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
              <div className="mb-3 text-sm font-medium text-gray-100">{t("generate_audio_label")}</div>
              <fieldset className="flex gap-4">
                <legend className="sr-only">{t("audio_settings_sr_label")}</legend>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="radio" name="audio" value="" checked={audioOverride === null}
                    onChange={() => setAudioOverride(null)} />
                  {t("follow_global_default")}
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="radio" name="audio" value="true" checked={audioOverride === true}
                    onChange={() => setAudioOverride(true)} />
                  {t("enabled_label")}
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="radio" name="audio" value="false" checked={audioOverride === false}
                    onChange={() => setAudioOverride(false)} />
                  {t("disabled_label")}
                </label>
              </fieldset>
            </div>
          </>
        )}

        {!options && (
          <div className="text-sm text-gray-500">{t("loading_config")}</div>
        )}

        {projectMembers && (
          <section className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
            <div className="flex items-start gap-3">
              <span className="rounded-md bg-gray-800 p-1.5 text-gray-300">
                <Users className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-gray-100">{t("project_members_title")}</h2>
                <p className="mt-1 text-xs text-gray-500">
                  {t("project_members_desc")}
                </p>
                <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs text-gray-400">
                  {t("project_owner_label")}: <span className="font-mono text-gray-200">{projectMembers.owner_user_id}</span>
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {projectMembers.members.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-800 px-3 py-3 text-sm text-gray-500">
                  {t("project_members_empty")}
                </div>
              ) : (
                projectMembers.members.map((member) => (
                  <div
                    key={member.user_id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-gray-100">{member.username ?? member.user_id}</div>
                      <div className="mt-0.5 truncate font-mono text-xs text-gray-500">
                        {member.user_id} · {t("project_member_role_editor")}
                      </div>
                    </div>
                    {canManageMembers && (
                      <button
                        type="button"
                        onClick={() => void handleRemoveMember(member.user_id)}
                        disabled={savingMember}
                        className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
                        aria-label={t("project_member_remove_aria", { userId: member.user_id })}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {canManageMembers ? (
              <form
                className="mt-4 flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleAddMember();
                }}
              >
                <div className="relative min-w-0 flex-1">
                  <label className="sr-only" htmlFor="project-member-user-id">
                    {t("project_member_user_id")}
                  </label>
                  <input
                    id="project-member-user-id"
                    value={memberUserId}
                    onChange={(e) => setMemberUserId(e.target.value)}
                    placeholder={t("project_member_user_id_placeholder")}
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus-ring"
                    autoComplete="off"
                  />
                  {(searchingUsers || userSearchResults.length > 0) && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-gray-800 bg-gray-900 shadow-xl">
                      {searchingUsers ? (
                        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("project_member_searching")}
                        </div>
                      ) : (
                        userSearchResults.map((user) => (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => {
                              setMemberUserId(user.username);
                              setUserSearchResults([]);
                            }}
                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-gray-800 focus-ring focus-visible:ring-inset"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-gray-100">{user.username}</span>
                              <span className="block truncate font-mono text-xs text-gray-500">{user.id}</span>
                            </span>
                            <span className="shrink-0 text-xs text-gray-500">{user.role}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={savingMember || !memberUserId.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
                >
                  {savingMember ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  {t("project_member_add")}
                </button>
              </form>
            ) : (
              <p className="mt-4 text-xs text-gray-500">{t("project_members_owner_only")}</p>
            )}
          </section>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={voidPromise(handleSave)}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-6 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50 focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            {saving ? t("common:saving") : t("common:save")}
          </button>
          <button
            onClick={() => guardedNavigate(`/app/projects/${projectName}`)}
            className="rounded-lg border border-gray-700 px-6 py-2 text-sm text-gray-300 hover:bg-gray-800 focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            {t("common:cancel")}
          </button>
        </div>
      </div>
        </main>
      </div>
      {showCreateModal && <CreateProjectModal />}
    </div>
  );
}
