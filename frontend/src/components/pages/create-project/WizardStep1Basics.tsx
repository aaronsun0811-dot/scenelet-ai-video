import { useEffect, useMemo, useState } from "react";
import { BookOpen, Clapperboard, Coins, Film, GraduationCap, ImagePlus, KeyRound, MapPinned, Megaphone, Mic, Trash2, Video, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GenerationModeSelector } from "@/components/shared/GenerationModeSelector";
import { CONTENT_TYPE_PRESETS, type ContentTypeId } from "@/data/content-types";
import type { TravelVideoSettings } from "@/types";
import type { GenerationMode } from "@/utils/generation-mode";

export interface WizardStep1Value {
  title: string;
  contentType: ContentTypeId;
  billingMode: "byok" | "platform_credits";
  contentMode: "narration" | "drama";
  aspectRatio: "9:16" | "16:9";
  generationMode: GenerationMode;
}

export type TravelVideoSettingsDraft = {
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

export const DEFAULT_TRAVEL_VIDEO_SETTINGS: TravelVideoSettingsDraft = {
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

const EMPTY_TRAVEL_REFERENCE_FILES: File[] = [];
const TRAVEL_ROUTE_SOURCES = ["google_street_view", "baidu_maps", "amap_maps", "manual", "reference_images"] as const;
const TRAVEL_LANGUAGES = ["auto", "zh", "en", "ja"] as const;
const TRAVEL_DURATIONS = ["45s", "60s", "90s", "120s", "150s", "180s", "custom"] as const;
const TRAVEL_CAMERA_STYLES = ["street_walk_turns", "street_drive", "landmark_focus", "cinematic_slow"] as const;
const TRAVEL_NARRATOR_PERSONAS = ["enthusiastic_guide", "local_friend", "documentary", "calm_guide"] as const;
export const TRAVEL_REFERENCE_IMAGE_LIMIT = 10;

export interface WizardStep1BasicsProps {
  value: WizardStep1Value;
  travelVideoSettings?: TravelVideoSettingsDraft;
  travelReferenceFiles?: File[];
  onChange: (next: WizardStep1Value) => void;
  onTravelVideoSettingsChange?: (next: TravelVideoSettingsDraft) => void;
  onTravelReferenceFilesChange?: (next: File[]) => void;
  onNext: () => void;
  onCancel: () => void;
}

export function WizardStep1Basics({
  value,
  travelVideoSettings = DEFAULT_TRAVEL_VIDEO_SETTINGS,
  travelReferenceFiles = EMPTY_TRAVEL_REFERENCE_FILES,
  onChange,
  onTravelVideoSettingsChange = () => {},
  onTravelReferenceFilesChange = () => {},
  onNext,
  onCancel,
}: WizardStep1BasicsProps) {
  const { t } = useTranslation(["common", "dashboard", "templates"]);
  const [titleError, setTitleError] = useState("");
  const travelReferencePreviews = useMemo(
    () =>
      travelReferenceFiles.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      })),
    [travelReferenceFiles],
  );
  const iconByType: Record<ContentTypeId, LucideIcon> = {
    scene_sketch: Clapperboard,
    short_drama: Film,
    fiction_adaptation: BookOpen,
    narration_story: Mic,
    ad_story: Megaphone,
    education_sketch: GraduationCap,
    travel_video: MapPinned,
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitleError("");
    onChange({ ...value, title: e.target.value });
  };

  const handleNext = () => {
    if (!value.title.trim()) {
      setTitleError(t("dashboard:project_title_required"));
      return;
    }
    onNext();
  };

  const updateTravelVideoSetting = (key: keyof TravelVideoSettingsDraft, next: string) => {
    onTravelVideoSettingsChange({
      ...travelVideoSettings,
      [key]: next,
      ...(key === "target_duration" && next === "custom" && !travelVideoSettings.custom_duration_seconds
        ? { custom_duration_seconds: 120 }
        : {}),
    });
  };

  const updateCustomDurationSeconds = (next: string) => {
    const parsed = Number(next);
    onTravelVideoSettingsChange({
      ...travelVideoSettings,
      target_duration: "custom",
      custom_duration_seconds: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null,
    });
  };

  useEffect(() => {
    return () => {
      travelReferencePreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [travelReferencePreviews]);

  const addTravelReferenceFiles = (files: FileList | null) => {
    const selected = Array.from(files ?? []).filter((file) => file.size > 0 && file.type.startsWith("image/"));
    if (selected.length === 0) return;
    onTravelReferenceFilesChange(
      [...travelReferenceFiles, ...selected].slice(0, TRAVEL_REFERENCE_IMAGE_LIMIT),
    );
  };

  const removeTravelReferenceFile = (index: number) => {
    onTravelReferenceFilesChange(travelReferenceFiles.filter((_, currentIndex) => currentIndex !== index));
  };

  const radioClass = (selected: boolean) =>
    `flex-1 cursor-pointer rounded-lg border px-3 py-2 text-center text-sm transition-colors ${
      selected
        ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
        : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
    }`;
  const titleInputId = "create-project-title-input";

  return (
    <div className="space-y-4">
      {/* Title */}
      <div>
        <label htmlFor={titleInputId} className="block text-sm font-medium text-gray-400 mb-1">
          {t("dashboard:project_title")}
          <span className="text-red-400 ml-0.5" aria-label="required">*</span>
        </label>
        <input
          id={titleInputId}
          type="text"
          value={value.title}
          onChange={handleTitleChange}
          placeholder={t("dashboard:rebirth_empress_example")}
          aria-required="true"
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-indigo-500"
        />
        {titleError && (
          <p className="mt-1 text-xs text-red-400">{titleError}</p>
        )}
        <p className="mt-1 text-xs text-gray-600">
          {t("dashboard:project_id_auto_gen_hint")}
        </p>
      </div>

      {/* Content Type */}
      <div>
        <label className="block text-sm font-medium text-gray-400 mb-1">
          {t("dashboard:content_type")}
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("dashboard:content_type")}>
          {CONTENT_TYPE_PRESETS.map((preset) => {
            const selected = value.contentType === preset.id;
            const Icon = iconByType[preset.id] ?? Video;
            return (
              <label
                key={preset.id}
                className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-indigo-500 bg-indigo-500/10 text-indigo-100"
                    : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                }`}
              >
                <input
                  type="radio"
                  name="contentType"
                  value={preset.id}
                  checked={selected}
                  onChange={() =>
                    onChange({
                      ...value,
                      contentType: preset.id,
                      contentMode: preset.contentMode,
                      aspectRatio: preset.aspectRatio,
                      generationMode: preset.generationMode,
                    })
                  }
                  className="sr-only"
                />
                <span
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                    selected ? "bg-indigo-500/20 text-indigo-200" : "bg-gray-900 text-gray-500"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(preset.labelKey)}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                    {t(preset.descriptionKey)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {value.contentType === "travel_video" && (
        <section className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-100">{t("dashboard:travel_video_settings_title")}</h3>
              <p className="mt-1 text-xs leading-5 text-gray-500">{t("dashboard:travel_video_settings_desc")}</p>
            </div>
            <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-100">
              {t("dashboard:travel_video_ready_badge")}
            </span>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_origin")}</span>
              <input
                value={travelVideoSettings.origin}
                onChange={(event) => updateTravelVideoSetting("origin", event.target.value)}
                placeholder={t("dashboard:travel_video_origin_placeholder")}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_destination")}</span>
              <input
                value={travelVideoSettings.destination}
                onChange={(event) => updateTravelVideoSetting("destination", event.target.value)}
                placeholder={t("dashboard:travel_video_destination_placeholder")}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_route_source")}</span>
              <select
                value={travelVideoSettings.route_source}
                onChange={(event) => updateTravelVideoSetting("route_source", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
              >
                {TRAVEL_ROUTE_SOURCES.map((source) => (
                  <option key={source} value={source}>{t(`dashboard:travel_video_route_source_${source}`)}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_language")}</span>
              <select
                value={travelVideoSettings.narration_language}
                onChange={(event) => updateTravelVideoSetting("narration_language", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
              >
                {TRAVEL_LANGUAGES.map((language) => (
                  <option key={language} value={language}>{t(`dashboard:travel_video_language_${language}`)}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_target_duration")}</span>
              <select
                value={travelVideoSettings.target_duration}
                onChange={(event) => updateTravelVideoSetting("target_duration", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
              >
                {TRAVEL_DURATIONS.map((duration) => (
                  <option key={duration} value={duration}>{t(`dashboard:travel_video_duration_${duration}`)}</option>
                ))}
              </select>
            </label>
            {travelVideoSettings.target_duration === "custom" && (
              <label className="block">
                <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_custom_duration_seconds")}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={travelVideoSettings.custom_duration_seconds ?? ""}
                  onChange={(event) => updateCustomDurationSeconds(event.target.value)}
                  placeholder={t("dashboard:travel_video_custom_duration_placeholder")}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
                />
                <span className="mt-1 block text-xs text-gray-500">{t("dashboard:travel_video_custom_duration_hint")}</span>
              </label>
            )}
            <label className="block">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_camera_style")}</span>
              <select
                value={travelVideoSettings.camera_style}
                onChange={(event) => updateTravelVideoSetting("camera_style", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
              >
                {TRAVEL_CAMERA_STYLES.map((style) => (
                  <option key={style} value={style}>{t(`dashboard:travel_video_camera_style_${style}`)}</option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_narrator_persona")}</span>
              <select
                value={travelVideoSettings.narrator_persona}
                onChange={(event) => updateTravelVideoSetting("narrator_persona", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
              >
                {TRAVEL_NARRATOR_PERSONAS.map((persona) => (
                  <option key={persona} value={persona}>{t(`dashboard:travel_video_narrator_${persona}`)}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-3 block">
            <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_route_notes")}</span>
            <textarea
              value={travelVideoSettings.route_notes}
              onChange={(event) => updateTravelVideoSetting("route_notes", event.target.value)}
              rows={3}
              placeholder={t("dashboard:travel_video_route_notes_placeholder")}
              className="mt-1 w-full resize-y rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm leading-6 text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
            />
            <span className="mt-1 block text-xs text-gray-500">{t("dashboard:travel_video_route_notes_hint")}</span>
          </label>

          {travelVideoSettings.route_source === "reference_images" && (
            <div className="mt-3 rounded-lg border border-cyan-300/20 bg-cyan-300/5 px-3 py-2 text-xs leading-5 text-cyan-100/80">
              {t("dashboard:travel_video_reference_images_create_hint")}
            </div>
          )}

          <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-gray-300">{t("dashboard:travel_video_reference_images")}</div>
                <p className="mt-1 text-xs leading-5 text-gray-500">{t("dashboard:travel_video_reference_images_hint")}</p>
                <p className="mt-1 text-xs leading-5 text-cyan-100/65">
                  {t("dashboard:travel_video_reference_images_rule", {
                    count: travelReferenceFiles.length,
                    limit: TRAVEL_REFERENCE_IMAGE_LIMIT,
                  })}
                </p>
              </div>
              <label className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                travelReferenceFiles.length >= TRAVEL_REFERENCE_IMAGE_LIMIT
                  ? "cursor-not-allowed border-gray-800 bg-gray-900/50 text-gray-500"
                  : "cursor-pointer border-gray-700 bg-gray-900 text-gray-200 hover:border-cyan-300/40 hover:bg-cyan-500/10"
              }`}>
                <ImagePlus className="h-3.5 w-3.5" />
                {t("dashboard:travel_video_reference_upload")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  disabled={travelReferenceFiles.length >= TRAVEL_REFERENCE_IMAGE_LIMIT}
                  className="sr-only"
                  aria-label={t("dashboard:travel_video_reference_upload")}
                  onChange={(event) => {
                    addTravelReferenceFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>

            {travelReferencePreviews.length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {travelReferencePreviews.map((preview, index) => (
                  <div key={`${preview.file.name}-${index}`} className="group relative overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
                    <img
                      src={preview.url}
                      alt={t("dashboard:travel_video_reference_image_alt")}
                      className="aspect-video w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeTravelReferenceFile(index)}
                      aria-label={t("dashboard:travel_video_reference_remove")}
                      className="absolute right-1 top-1 rounded-md bg-gray-950/80 p-1 text-gray-300 opacity-90 transition-colors hover:bg-red-500/90 hover:text-white"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500">
                {t("dashboard:travel_video_reference_images_empty")}
              </div>
            )}
          </div>

          <label className="mt-3 block">
            <span className="text-xs font-medium text-gray-400">{t("dashboard:travel_video_character_notes")}</span>
            <textarea
              value={travelVideoSettings.character_notes}
              onChange={(event) => updateTravelVideoSetting("character_notes", event.target.value)}
              rows={2}
              placeholder={t("dashboard:travel_video_character_notes_placeholder")}
              className="mt-1 w-full resize-y rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm leading-6 text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
            />
          </label>
        </section>
      )}

      {/* Billing Mode */}
      <div>
        <label className="block text-sm font-medium text-gray-400 mb-1">
          {t("dashboard:billing_mode")}
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("dashboard:billing_mode")}>
          {([
            {
              value: "byok",
              label: t("dashboard:billing_mode_byok"),
              description: t("dashboard:billing_mode_byok_desc"),
              Icon: KeyRound,
            },
            {
              value: "platform_credits",
              label: t("dashboard:billing_mode_platform"),
              description: t("dashboard:billing_mode_platform_desc"),
              Icon: Coins,
            },
          ] as const).map(({ value: billingMode, label, description, Icon }) => {
            const selected = value.billingMode === billingMode;
            return (
              <label
                key={billingMode}
                className={`flex min-h-[82px] cursor-pointer gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-indigo-500 bg-indigo-500/10 text-indigo-100"
                    : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                }`}
              >
                <input
                  type="radio"
                  name="billingMode"
                  value={billingMode}
                  checked={selected}
                  onChange={() => onChange({ ...value, billingMode })}
                  className="sr-only"
                />
                <span
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                    selected ? "bg-indigo-500/20 text-indigo-200" : "bg-gray-900 text-gray-500"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                    {description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Aspect Ratio */}
      <div>
        <label className="block text-sm font-medium text-gray-400 mb-1">
          {t("dashboard:aspect_ratio")}
        </label>
        <div className="flex gap-3" role="radiogroup" aria-label={t("dashboard:aspect_ratio")}>
          <label className={radioClass(value.aspectRatio === "9:16")}>
            <input
              type="radio"
              name="aspectRatio"
              value="9:16"
              checked={value.aspectRatio === "9:16"}
              onChange={() => onChange({ ...value, aspectRatio: "9:16" })}
              className="sr-only"
            />
            {t("dashboard:portrait_9_16")}
          </label>
          <label className={radioClass(value.aspectRatio === "16:9")}>
            <input
              type="radio"
              name="aspectRatio"
              value="16:9"
              checked={value.aspectRatio === "16:9"}
              onChange={() => onChange({ ...value, aspectRatio: "16:9" })}
              className="sr-only"
            />
            {t("dashboard:landscape_16_9")}
          </label>
        </div>
      </div>

      {/* Generation Mode */}
      <div>
        <label className="block text-sm font-medium text-gray-400 mb-0.5">
          {t("dashboard:generation_mode")}
        </label>
        <GenerationModeSelector
          value={value.generationMode}
          onChange={(next) => onChange({ ...value, generationMode: next })}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-800">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          {t("common:cancel")}
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!value.title.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("templates:next_step")}
        </button>
      </div>
    </div>
  );
}
