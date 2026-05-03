/**
 * Project-related type definitions.
 *
 * Maps to backend models in:
 * - lib/project_manager.py (ProjectOverview, project.json structure)
 * - lib/status_calculator.py (ProjectStatus, EpisodeMeta computed fields)
 * - server/routers/projects.py (ProjectSummary list response)
 */

export interface ProjectOverview {
  synopsis: string;
  genre: string;
  theme: string;
  world_setting: string;
  generated_at?: string;
}

export interface Character {
  description: string;
  character_sheet?: string;
  voice_style?: string;
  reference_image?: string;
  asset_source?: ProjectAssetSource;
}

export interface ProjectAssetSource {
  kind?: string;
  asset_id?: string;
  asset_type?: string;
  source_kind?: string;
  source_project?: string | null;
  source_file?: string | null;
}

export interface Scene {
  description: string;
  scene_sheet?: string;
  asset_source?: ProjectAssetSource;
}

export interface Prop {
  description: string;
  prop_sheet?: string;
  asset_source?: ProjectAssetSource;
}

export interface AspectRatio {
  characters?: string;
  scenes?: string;
  props?: string;
  storyboard?: string;
  video?: string;
}

export interface ProgressCategory {
  total: number;
  completed: number;
}

export interface EpisodesSummary {
  total: number;
  scripted: number;
  in_production: number;
  completed: number;
}

/** Injected by StatusCalculator.calculate_project_status at read time */
export interface ProjectStatus {
  current_phase: "setup" | "worldbuilding" | "scripting" | "production" | "completed";
  phase_progress: number;
  characters: ProgressCategory;
  scenes: ProgressCategory;
  props: ProgressCategory;
  episodes_summary: EpisodesSummary;
}

export interface EpisodeMeta {
  episode: number;
  title: string;
  script_file: string;
  /** Injected by StatusCalculator at read time */
  scenes_count?: number;
  /** Injected by StatusCalculator at read time */
  script_status?: "none" | "segmented" | "generated";
  /** Injected by StatusCalculator at read time */
  status?: "draft" | "scripted" | "in_production" | "completed" | "missing";
  /** Injected by StatusCalculator at read time */
  duration_seconds?: number;
  /** Injected by StatusCalculator at read time */
  storyboards?: ProgressCategory;
  /** Injected by StatusCalculator at read time */
  videos?: ProgressCategory;
  /** Injected by StatusCalculator at read time (reference_video mode only) */
  units_count?: number;
  /**
   * Optional episode-level override; falls back to project.generation_mode.
   * Never "single" — legacy value only exists at project level.
   */
  generation_mode?: "storyboard" | "grid" | "reference_video";
}

export interface ModelSettingEntry {
  resolution?: string | null;
}

export interface TravelVideoSettings {
  origin?: string | null;
  destination?: string | null;
  route_source?: "google_street_view" | "baidu_maps" | "amap_maps" | "manual" | "reference_images" | null;
  route_notes?: string | null;
  reference_images?: string[] | null;
  route_preview?: TravelRoutePreview | null;
  narration_language?: "auto" | "zh" | "en" | "ja" | null;
  target_duration?: "45s" | "60s" | "90s" | "120s" | "150s" | "180s" | "custom" | null;
  custom_duration_seconds?: number | null;
  camera_style?: "street_walk_turns" | "street_drive" | "landmark_focus" | "cinematic_slow" | null;
  narrator_persona?: "enthusiastic_guide" | "local_friend" | "documentary" | "calm_guide" | null;
  character_notes?: string | null;
}

export interface TravelRoutePreviewNode {
  id: string;
  label: string;
  instruction?: string | null;
  lat?: number | null;
  lng?: number | null;
  heading?: number | null;
  distance_text?: string | null;
  duration_text?: string | null;
  street_view_status?: string | null;
  pano_id?: string | null;
  street_view_lat?: number | null;
  street_view_lng?: number | null;
  source: "google" | "baidu" | "amap" | "manual" | "reference_image";
}

export interface TravelRoutePreviewIssue {
  code: string;
  message: string;
}

export interface TravelRoutePreview {
  source: "google" | "baidu" | "amap" | "manual" | "reference_images" | "hybrid";
  google_configured: boolean;
  route_ready: boolean;
  origin?: string | null;
  destination?: string | null;
  summary?: string | null;
  distance_text?: string | null;
  duration_text?: string | null;
  nodes: TravelRoutePreviewNode[];
  reference_images: string[];
  warnings: TravelRoutePreviewIssue[];
  generated_at?: string | null;
}

export type ProjectMemberRole = "editor";
export type CurrentProjectRole = "owner" | ProjectMemberRole | null;

export interface ProjectMember {
  user_id: string;
  username?: string;
  role: ProjectMemberRole;
  added_at?: string;
}

export interface ProjectMembersResponse {
  owner_user_id: string;
  current_user_role?: CurrentProjectRole;
  members: ProjectMember[];
}

export interface ProjectData {
  title: string;
  owner_user_id?: string;
  project_access?: {
    members?: Record<string, { role: ProjectMemberRole; added_at?: string }>;
  };
  content_type?: string | null;
  billing_mode?: "byok" | "platform_credits" | null;
  content_mode: "narration" | "drama";
  style: string;
  style_template_id?: string | null;
  style_image?: string;
  style_description?: string;
  character_style_prompt?: string | null;
  overview?: ProjectOverview;
  aspect_ratio?: string | AspectRatio;  // 新项目为 string，旧项目可能为 dict
  default_duration?: number | null;     // 新增
  default_duration_explicit?: boolean | null;
  schema_version?: number;
  episodes: EpisodeMeta[];
  characters: Record<string, Character>;
  scenes?: Record<string, Scene>;
  props?: Record<string, Prop>;
  /** Injected by StatusCalculator.enrich_project at read time */
  status?: ProjectStatus;
  video_backend?: string | null;
  image_backend?: string | null;
  /** Canonical values: storyboard | grid | reference_video. "single" is legacy-only. */
  generation_mode?: "storyboard" | "grid" | "reference_video" | "single";
  video_generate_audio?: boolean | null;
  text_backend_script?: string | null;
  text_backend_overview?: string | null;
  text_backend_style?: string | null;
  model_settings?: Record<string, ModelSettingEntry>;
  travel_video_settings?: TravelVideoSettings | null;
  /** Legacy field: keyed by model_id only (before composite key refactor). Read-only at UI layer. */
  video_model_settings?: Record<string, { resolution?: string | null }>;
  metadata?: {
    created_at: string;
    updated_at: string;
  };
}

/**
 * Summary shape returned by GET /api/v1/projects (list endpoint).
 *
 * Note: `status` may be an empty object `{}` when the project
 * has no project.json or encounters an error during loading.
 */
export interface ProjectSummary {
  name: string;
  title: string;
  owner_user_id?: string;
  current_user_role?: CurrentProjectRole;
  content_type?: string | null;
  billing_mode?: "byok" | "platform_credits" | null;
  style: string;
  style_template_id?: string | null;
  style_image?: string | null;
  travel_video_settings?: TravelVideoSettings | null;
  thumbnail: string | null;
  status: ProjectStatus | Record<string, never>;
}

export type ImportConflictPolicy = "prompt" | "rename" | "overwrite";

export interface ArchiveDiagnostic {
  code: string;
  message: string;
  location?: string;
}

export interface ImportSuccessDiagnostics {
  auto_fixed: ArchiveDiagnostic[];
  warnings: ArchiveDiagnostic[];
}

export interface ImportFailureDiagnostics {
  blocking: ArchiveDiagnostic[];
  auto_fixable: ArchiveDiagnostic[];
  warnings: ArchiveDiagnostic[];
}

export interface ExportDiagnostics {
  blocking: ArchiveDiagnostic[];
  auto_fixed: ArchiveDiagnostic[];
  warnings: ArchiveDiagnostic[];
}

export interface ProjectArchiveDeliveryIssue {
  code: string;
  message: string;
  location?: string;
  items?: string[];
}

export interface ProjectArchiveDeliveryAssetSummary {
  ready: number;
  total: number;
  missing: string[];
}

export interface ProjectArchiveDeliveryEpisodeReport {
  episode: number | null;
  title: string;
  script_file: string;
  script_ready: boolean;
  status: string;
  storyboards: ProjectArchiveDeliveryAssetSummary;
  videos: ProjectArchiveDeliveryAssetSummary;
  blocking_issues: ProjectArchiveDeliveryIssue[];
  warnings: ProjectArchiveDeliveryIssue[];
}

export interface ProjectArchiveDeliveryTotals {
  episodes: number;
  ready_episodes: number;
  scripts_ready: number;
  storyboards_ready: number;
  storyboards_total: number;
  videos_ready: number;
  videos_total: number;
  blocking_issues: number;
  warnings: number;
}

export interface ProjectArchiveTravelRouteNodeReport {
  id: string;
  label: string;
  instruction?: string | null;
  source?: string | null;
  covered: boolean;
  matched_units: string[];
}

export interface ProjectArchiveTravelRouteReport {
  route_ready: boolean;
  source?: string | null;
  origin?: string | null;
  destination?: string | null;
  summary?: string | null;
  distance_text?: string | null;
  duration_text?: string | null;
  nodes_total: number;
  nodes_covered: number;
  reference_images_count: number;
  usable_reference_images_count: number;
  nodes: ProjectArchiveTravelRouteNodeReport[];
}

export interface ProjectArchiveModelRuleAuditSummary {
  total: number;
  by_mode: Record<string, number>;
  by_media_type: Record<string, number>;
  artifact_files: string[];
}

export interface ProjectArchiveModelRuleAuditRule {
  media_type?: string | null;
  rule_target?: string | null;
  mode?: string | null;
  mode_label?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  target_label?: string | null;
  skill_name?: string | null;
  billing_mode?: string | null;
}

export interface ProjectArchiveModelRuleAuditItem {
  task_id: string;
  task_type?: string | null;
  media_type?: string | null;
  resource_id?: string | null;
  script_file?: string | null;
  status?: string | null;
  source?: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at?: string | null;
  rule: ProjectArchiveModelRuleAuditRule;
}

export interface ProjectArchiveModelRuleAuditManifest extends ProjectArchiveModelRuleAuditSummary {
  format_version: number;
  project_name?: string | null;
  generated_at?: string | null;
  items: ProjectArchiveModelRuleAuditItem[];
}

export interface ProjectArchiveDeliveryReport {
  format_version: number;
  status: string;
  generated_at?: string;
  totals: ProjectArchiveDeliveryTotals;
  episodes: ProjectArchiveDeliveryEpisodeReport[];
  travel_route?: ProjectArchiveTravelRouteReport | null;
  model_rule_audit?: ProjectArchiveModelRuleAuditSummary | null;
}

export interface TravelRouteAssetNode {
  id: string;
  label: string;
  instruction?: string | null;
  source?: string | null;
  covered: boolean;
  matched_units: string[];
  matched_unit_details?: TravelRouteAssetUnitRef[];
  reference_images: string[];
  distance_text?: string | null;
  duration_text?: string | null;
  street_view_status?: string | null;
}

export interface TravelRouteAssetUnitRef {
  id: string;
  episode?: number | null;
  title?: string | null;
  script_file?: string | null;
  video_clip?: string | null;
  video_thumbnail?: string | null;
  status?: string | null;
}

export interface TravelRouteAssetReference {
  id: string;
  path: string;
  kind: "local" | "remote";
  usable: boolean;
  archive_path?: string | null;
  html_src?: string | null;
  used_by_nodes: string[];
}

export interface TravelRouteAssetManifest {
  format_version: number;
  generated_at?: string;
  route: {
    route_ready: boolean;
    source?: string | null;
    origin?: string | null;
    destination?: string | null;
    summary?: string | null;
    distance_text?: string | null;
    duration_text?: string | null;
  };
  node_coverage: {
    total: number;
    covered: number;
    missing: string[];
  };
  reference_images: {
    total: number;
    usable: number;
    items: TravelRouteAssetReference[];
  };
  nodes: TravelRouteAssetNode[];
}

export interface ImportProjectResponse {
  success: boolean;
  project_name: string;
  project: ProjectData;
  warnings: string[];
  conflict_resolution: "none" | "renamed" | "overwritten";
  diagnostics: ImportSuccessDiagnostics;
}
