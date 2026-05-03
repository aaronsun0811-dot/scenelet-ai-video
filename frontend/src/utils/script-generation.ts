import type { EpisodeScript } from "@/types";

export type PromptField = "image_prompt" | "video_prompt";

export type ScriptGenerationItem = {
  id: string;
  imagePrompt: unknown;
  videoPrompt: unknown;
  duration: number;
  hasStoryboard: boolean;
  hasVideo: boolean;
};

export function normalizeScriptFileKey(scriptFile?: string | null): string | null {
  const value = scriptFile?.trim();
  return value ? value.replace(/^scripts\//, "") : null;
}

export function getScriptByFileKey(
  scripts: Record<string, EpisodeScript>,
  scriptFile?: string | null,
): EpisodeScript | null {
  const normalized = normalizeScriptFileKey(scriptFile);
  const candidates = [
    scriptFile?.trim(),
    normalized,
    normalized ? `scripts/${normalized}` : null,
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const script = scripts[candidate];
    if (script) return script;
  }
  return null;
}

export function resolveSegmentPrompt(
  scripts: Record<string, EpisodeScript>,
  segmentId: string,
  field: PromptField,
  scriptFile?: string,
): { resolvedFile: string; prompt: unknown; duration: number } | null {
  const firstFile = Object.keys(scripts)[0];
  const resolvedFile = normalizeScriptFileKey(scriptFile) ?? normalizeScriptFileKey(firstFile) ?? firstFile;
  if (!resolvedFile) return null;
  const script = getScriptByFileKey(scripts, scriptFile ?? firstFile);
  if (!script) return null;
  if (script.content_mode === "reference_video") {
    const unit = (script.video_units ?? []).find((u) => u.unit_id === segmentId);
    return {
      resolvedFile,
      prompt: unit ? unit.shots.map((shot) => shot.text).join("\n") : "",
      duration: unit?.duration_seconds ?? 4,
    };
  }

  const seg =
    script.content_mode === "narration"
      ? (script.segments ?? []).find((s) => s.segment_id === segmentId)
      : (script.scenes ?? []).find((s) => s.scene_id === segmentId);
  return {
    resolvedFile,
    prompt: seg?.[field] ?? "",
    duration: seg?.duration_seconds ?? 4,
  };
}

export function getScriptGenerationItems(script: EpisodeScript): ScriptGenerationItem[] {
  if (script.content_mode === "narration") {
    return (script.segments ?? []).map((segment) => ({
      id: segment.segment_id,
      imagePrompt: segment.image_prompt,
      videoPrompt: segment.video_prompt,
      duration: segment.duration_seconds,
      hasStoryboard: Boolean(segment.generated_assets?.storyboard_image),
      hasVideo: Boolean(segment.generated_assets?.video_clip),
    }));
  }

  if (script.content_mode === "reference_video") {
    return (script.video_units ?? []).map((unit) => ({
      id: unit.unit_id,
      imagePrompt: "",
      videoPrompt: unit.shots.map((shot) => shot.text).join("\n"),
      duration: unit.duration_seconds,
      hasStoryboard: false,
      hasVideo: Boolean(unit.generated_assets?.video_clip),
    }));
  }

  return (script.scenes ?? []).map((scene) => ({
    id: scene.scene_id,
    imagePrompt: scene.image_prompt,
    videoPrompt: scene.video_prompt,
    duration: scene.duration_seconds,
    hasStoryboard: Boolean(scene.generated_assets?.storyboard_image),
    hasVideo: Boolean(scene.generated_assets?.video_clip),
  }));
}
