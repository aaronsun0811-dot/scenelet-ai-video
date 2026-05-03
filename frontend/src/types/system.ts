export type ModelRuleMode = "default" | "prompt" | "github_skill" | "uploaded_skill";

export type ModelSkillRuntime = "openai" | "hermes_agent" | "openclaw" | "claude_code";

export interface ModelRuleConfig {
  mode: ModelRuleMode;
  prompt?: string;
  skill_runtime?: ModelSkillRuntime;
  skill_github_url?: string;
  skill_name?: string;
  skill_content?: string;
}

export interface SystemConfigSettings {
  default_video_backend: string;
  default_image_backend: string;
  default_text_backend: string;
  text_backend_script: string;
  text_backend_overview: string;
  text_backend_style: string;
  video_generate_audio: boolean;
  anthropic_api_key: { is_set: boolean; masked: string | null };
  google_maps_api_key: { is_set: boolean; masked: string | null };
  baidu_maps_api_key?: { is_set: boolean; masked: string | null };
  amap_maps_api_key?: { is_set: boolean; masked: string | null };
  anthropic_base_url: string;
  anthropic_model: string;
  agent_model_backend: string;
  anthropic_default_haiku_model: string;
  anthropic_default_opus_model: string;
  anthropic_default_sonnet_model: string;
  claude_code_subagent_model: string;
  agent_session_cleanup_delay_seconds: number;
  agent_max_concurrent_sessions: number;
  about_title: string;
  about_subtitle: string;
  about_body: string;
  about_contact_label: string;
  about_contact_url: string;
  model_rule_configs: Record<string, ModelRuleConfig>;
}

export interface SystemConfigOptions {
  video_backends: string[];
  image_backends: string[];
  text_backends: string[];
  agent_backends?: string[];
  provider_names?: Record<string, string>;
}

export interface GetSystemConfigResponse {
  settings: SystemConfigSettings;
  options: SystemConfigOptions;
}

export interface MapProviderTestResponse {
  success: boolean;
  provider: string;
  message: string;
}

export interface GithubSkillImportResponse {
  skill_name: string;
  skill_content: string;
  raw_url: string;
}

export interface SystemVersionReleaseInfo {
  version: string;
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
}

export interface GetSystemVersionResponse {
  current: { version: string };
  latest: SystemVersionReleaseInfo | null;
  has_update: boolean;
  checked_at: string;
  update_check_error: string | null;
}

export interface ProjectNamespaceMigrationItem {
  project_name: string;
  owner_user_id?: string;
  source_path?: string;
  target_path?: string;
  reason?: string;
  message?: string;
}

export interface ProjectNamespaceMigrationResponse {
  dry_run: boolean;
  candidates: ProjectNamespaceMigrationItem[];
  migrated: ProjectNamespaceMigrationItem[];
  skipped: ProjectNamespaceMigrationItem[];
  conflicts: ProjectNamespaceMigrationItem[];
  errors: ProjectNamespaceMigrationItem[];
}

export interface SystemConfigPatch {
  default_video_backend?: string;
  default_image_backend?: string;
  default_text_backend?: string;
  text_backend_script?: string;
  text_backend_overview?: string;
  text_backend_style?: string;
  video_generate_audio?: boolean;
  anthropic_api_key?: string;
  google_maps_api_key?: string;
  baidu_maps_api_key?: string;
  amap_maps_api_key?: string;
  anthropic_base_url?: string;
  anthropic_model?: string;
  agent_model_backend?: string;
  anthropic_default_haiku_model?: string;
  anthropic_default_opus_model?: string;
  anthropic_default_sonnet_model?: string;
  claude_code_subagent_model?: string;
  agent_session_cleanup_delay_seconds?: number;
  agent_max_concurrent_sessions?: number;
  about_title?: string;
  about_subtitle?: string;
  about_body?: string;
  about_contact_label?: string;
  about_contact_url?: string;
  model_rule_configs?: Record<string, ModelRuleConfig>;
}
