/**
 * API 调用封装 (TypeScript)
 *
 * Typed API layer for all backend endpoints.
 * Import: import { API } from '@/api';
 */

import type {
  ProjectData,
  ProjectMemberRole,
  ProjectMembersResponse,
  ProjectSummary,
  ImportConflictPolicy,
  ImportProjectResponse,
  ExportDiagnostics,
  ProjectArchiveDeliveryReport,
  ProjectArchiveModelRuleAuditManifest,
  ImportFailureDiagnostics,
  EpisodeScript,
  TaskItem,
  TaskStats,
  SessionMeta,
  AssistantSnapshot,
  SkillInfo,
  ProjectOverview,
  ProjectChangeBatchPayload,
  ProjectEventSnapshotPayload,
  GetSystemConfigResponse,
  GithubSkillImportResponse,
  MapProviderTestResponse,
  GetSystemVersionResponse,
  ProjectNamespaceMigrationResponse,
  SystemConfigPatch,
  ApiKeyInfo,
  CreateApiKeyResponse,
  ProviderInfo,
  ProviderConfigDetail,
  ProviderTestResult,
  ProviderCredential,
  UsageStatsResponse,
  CustomProviderInfo,
  CustomProviderModelInfo,
  CustomProviderCreateRequest,
  CustomProviderModelInput,
  DiscoveredModel,
  CostEstimateResponse,
  ReferenceVideoUnit,
  ReferenceResource,
  TransitionType,
  TravelRoutePreview,
  TravelRouteAssetManifest,
  TravelVideoSettings,
} from "@/types";
import type { ContentTypeId } from "@/data/content-types";
import type { GenerationMode } from "@/utils/generation-mode";
import type { GridGeneration } from "@/types/grid";
import type { Asset, AssetType, AssetCreatePayload, AssetUpdatePayload } from "@/types/asset";
import { getToken, clearToken } from "@/utils/auth";
import i18n from "./i18n";

// ==================== Helper types ====================

/** Login response from POST /auth/token (mirrors backend TokenResponse). */
export interface LoginResponse {
  access_token: string;
  token_type: string;
}

export interface VerifyAuthResponse {
  valid: boolean;
  username: string;
  user_id: string;
  role: string;
}

export interface AuthCapabilitiesResponse {
  db_users_enabled: boolean;
  registration_enabled: boolean;
}

export interface RegisterPayload {
  username: string;
  password: string;
}

export interface UserSearchItem {
  id: string;
  username: string;
  role: string;
}

export interface AdminUserItem extends UserSearchItem {
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface UpdateUserPayload {
  role?: "admin" | "user";
  is_active?: boolean;
  password?: string;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  role?: "admin" | "user";
}

/** Standard error response body from backend (mirrors FastAPI HTTPException detail). */
export interface ErrorResponse {
  detail: string | { msg?: string }[];
}

/**
 * Error thrown when uploading a source file conflicts with an existing file
 * (HTTP 409). Carries the existing filename and a server-suggested alternative
 * so callers can prompt the user to retry with `on_conflict=rename|replace`.
 */
export class ConflictError extends Error {
  constructor(
    public readonly existing: string,
    public readonly suggestedName: string,
    message: string
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Error payload from the import project endpoint (extends ErrorResponse with import-specific fields). */
interface ImportErrorPayload {
  detail?: string | { msg?: string }[];
  errors?: string[];
  warnings?: string[];
  conflict_project_name?: string;
  diagnostics?: unknown;
}

/** Version metadata returned by the versions API. */
export interface VersionInfo {
  version: number;
  filename: string;
  created_at: string;
  file_size: number;
  is_current: boolean;
  file_url?: string;
  prompt?: string;
  restored_from?: number;
}

/** Options for {@link API.openTaskStream}. */
export interface TaskStreamOptions {
  projectName?: string;
  lastEventId?: number | string;
  onSnapshot?: (payload: TaskStreamSnapshotPayload, event: MessageEvent) => void;
  onTask?: (payload: TaskStreamTaskPayload, event: MessageEvent) => void;
  onError?: (event: Event) => void;
}

export interface TaskStreamSnapshotPayload {
  tasks: TaskItem[];
  stats: TaskStats;
}

export interface TaskStreamTaskPayload {
  action: "created" | "updated";
  task: TaskItem;
  stats: TaskStats;
}

export interface ProjectEventStreamOptions {
  projectName: string;
  onSnapshot?: (payload: ProjectEventSnapshotPayload, event: MessageEvent) => void;
  onChanges?: (payload: ProjectChangeBatchPayload, event: MessageEvent) => void;
  onError?: (event: Event) => void;
}

/** Filters for {@link API.listTasks} and {@link API.listProjectTasks}. */
export interface TaskListFilters {
  projectName?: string;
  status?: string;
  taskType?: string;
  source?: string;
  page?: number;
  pageSize?: number;
}

/** Filters for {@link API.getUsageStats} and {@link API.getUsageCalls}. */
export interface UsageStatsFilters {
  projectName?: string;
  startDate?: string;
  endDate?: string;
}

export interface UsageCallsFilters {
  projectName?: string;
  callType?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

/** Generic success response used by many endpoints. */
export interface SuccessResponse {
  success: boolean;
  message?: string;
}

export interface CreditLedgerEntry {
  id: number;
  amount: number;
  kind: string;
  status: string;
  reference_type?: string | null;
  reference_id?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface CreditBalanceResponse {
  balance: number;
  available_balance?: number;
  reserved_generation_credits?: number;
  minimum_generation_balance: number;
  pending_purchase_credits: number;
  entries: CreditLedgerEntry[];
}

export type CreditReconciliationAction = "release_stale_reservations";

export interface CreditReconciliationIssue {
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
  detail: string;
  suggestion?: string | null;
  action?: CreditReconciliationAction | null;
  action_label?: string | null;
  acknowledged?: boolean;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  acknowledgement_note?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  project_name?: string | null;
  task_id?: string | null;
  task_status?: string | null;
  resource_id?: string | null;
  ledger_entry_id?: number | null;
  api_call_id?: number | null;
  amount?: number | null;
  created_at?: string | null;
}

export interface CreditReconciliationResponse {
  ok: boolean;
  checked_entries: number;
  checked_tasks: number;
  checked_api_calls: number;
  issues: CreditReconciliationIssue[];
}

export interface CreditReconciliationActionPayload {
  action: CreditReconciliationAction;
  note?: string | null;
}

export interface CreditReconciliationAudit {
  id: number;
  action: string;
  status: string;
  actor_user_id?: string | null;
  fixed_count: number;
  skipped_count: number;
  note?: string | null;
  summary?: string | null;
  snapshot?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface CreditReconciliationAuditsResponse {
  audits: CreditReconciliationAudit[];
}

export interface CreditReconciliationNotePayload {
  note: string;
  issue_code?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  project_name?: string | null;
  task_id?: string | null;
}

export interface CreditReconciliationAcknowledgePayload {
  note: string;
  issue_code: string;
  reference_type?: string | null;
  reference_id?: string | null;
  project_name?: string | null;
  task_id?: string | null;
}

export interface CreditReconciliationReopenPayload {
  note: string;
  issue_code: string;
  reference_type?: string | null;
  reference_id?: string | null;
  project_name?: string | null;
  task_id?: string | null;
}

export interface CreditReconciliationActionResult {
  action: CreditReconciliationAction;
  fixed_count: number;
  skipped_count: number;
  released: CreditLedgerEntry[];
  audit: CreditReconciliationAudit;
  message: string;
}

export interface CreditPackage {
  id: string;
  credits: number;
  currency: string;
  price_minor: number;
  description?: string | null;
}

export interface CreditPackagesResponse {
  packages: CreditPackage[];
}

export interface StripeBillingStatus {
  configured: boolean;
  missing: string[];
  mode: "test" | "live" | "unknown";
  sandbox_tools_enabled: boolean;
  frontend_base_url: string;
  webhook_path: string;
}

export interface CreateCreditOrderPayload {
  package_id: string;
  payment_method?: "manual" | "wechat" | "alipay" | "stripe";
  idempotency_key?: string;
}

export interface GrantCreditsPayload {
  amount: number;
  user_id?: string | null;
  description?: string | null;
  idempotency_key?: string;
}

export interface CreditOrderResponse {
  order_id: string;
  status: string;
  package: CreditPackage;
  payment_method: string;
  payment_url?: string | null;
  ledger_entry: CreditLedgerEntry;
}

export type GenerationPreflightTaskType =
  | "storyboard"
  | "video"
  | "character"
  | "scene"
  | "prop"
  | "grid"
  | "reference_video"
  | "workflow";

export interface GenerationPreflightRequest {
  task_type: GenerationPreflightTaskType;
  payload?: Record<string, unknown>;
  resource_id?: string | null;
  count?: number;
}

export interface GenerationPreflightIssue {
  code: string;
  message: string;
}

export interface GenerationPreflightCheck {
  code: string;
  label: string;
  status: "ok" | "warning" | "blocking";
  message: string;
  action_label?: string | null;
  action_route?: string | null;
  action_kind?: string | null;
  action_payload?: Record<string, unknown> | null;
}

export interface GenerationPreflightResponse {
  project_name: string;
  task_type: GenerationPreflightTaskType;
  resource_id?: string | null;
  billing_mode: "byok" | "platform_credits";
  required_credits: number;
  count: number;
  balance?: number | null;
  available_balance?: number | null;
  reserved_generation_credits?: number | null;
  minimum_generation_balance: number;
  can_submit: boolean;
  blocking: GenerationPreflightIssue[];
  warnings: GenerationPreflightIssue[];
  checks?: GenerationPreflightCheck[];
}

/** Payload for {@link API.createProject}. */
export interface CreateProjectPayload {
  title: string;
  name?: string;
  content_type?: ContentTypeId;
  billing_mode?: "byok" | "platform_credits";
  content_mode?: "narration" | "drama";
  aspect_ratio?: "9:16" | "16:9";
  generation_mode?: GenerationMode;
  default_duration?: number | null;
  style_template_id?: string | null;
  video_backend?: string | null;
  image_backend?: string | null;
  text_backend_script?: string | null;
  text_backend_overview?: string | null;
  text_backend_style?: string | null;
  character_style_prompt?: string | null;
  model_settings?: Record<string, { resolution?: string | null }>;
  travel_video_settings?: TravelVideoSettings | null;
}

/** Draft metadata returned by listDrafts. */
export interface DraftInfo {
  episode: number;
  step: number;
  filename: string;
  modified_at: string;
}

function normalizeDiagnosticsBucket(value: unknown): { code: string; message: string; location?: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is { code: string; message: string; location?: string } =>
        Boolean(item)
        && typeof item === "object"
        && typeof (item as { code?: unknown }).code === "string"
        && typeof (item as { message?: unknown }).message === "string"
    )
    .map((item) => ({
      code: item.code,
      message: item.message,
      ...(typeof item.location === "string" ? { location: item.location } : {}),
    }));
}

function normalizeImportFailureDiagnostics(value: unknown): ImportFailureDiagnostics {
  const payload = (value && typeof value === "object") ? value as Record<string, unknown> : {};
  return {
    blocking: normalizeDiagnosticsBucket(payload.blocking),
    auto_fixable: normalizeDiagnosticsBucket(payload.auto_fixable),
    warnings: normalizeDiagnosticsBucket(payload.warnings),
  };
}

function normalizeExportDiagnostics(value: unknown): ExportDiagnostics {
  const payload = (value && typeof value === "object") ? value as Record<string, unknown> : {};
  return {
    blocking: normalizeDiagnosticsBucket(payload.blocking),
    auto_fixed: normalizeDiagnosticsBucket(payload.auto_fixed),
    warnings: normalizeDiagnosticsBucket(payload.warnings),
  };
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
}

function normalizeDeliveryIssues(value: unknown): ProjectArchiveDeliveryReport["episodes"][number]["blocking_issues"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item)
        && typeof item === "object"
        && typeof (item as { code?: unknown }).code === "string"
        && typeof (item as { message?: unknown }).message === "string",
    )
    .map((item) => ({
      code: item.code as string,
      message: item.message as string,
      ...(typeof item.location === "string" ? { location: item.location } : {}),
      items: normalizeStringList(item.items),
    }));
}

function normalizeDeliveryAssetSummary(value: unknown): ProjectArchiveDeliveryReport["episodes"][number]["storyboards"] {
  const payload = (value && typeof value === "object") ? value as Record<string, unknown> : {};
  return {
    ready: asFiniteNumber(payload.ready),
    total: asFiniteNumber(payload.total),
    missing: normalizeStringList(payload.missing),
  };
}

function normalizeTravelRouteDeliveryReport(value: unknown): ProjectArchiveDeliveryReport["travel_route"] {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const nodesPayload = Array.isArray(payload.nodes) ? payload.nodes : [];
  return {
    route_ready: payload.route_ready === true,
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
    ...(typeof payload.origin === "string" ? { origin: payload.origin } : {}),
    ...(typeof payload.destination === "string" ? { destination: payload.destination } : {}),
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
    ...(typeof payload.distance_text === "string" ? { distance_text: payload.distance_text } : {}),
    ...(typeof payload.duration_text === "string" ? { duration_text: payload.duration_text } : {}),
    nodes_total: asFiniteNumber(payload.nodes_total),
    nodes_covered: asFiniteNumber(payload.nodes_covered),
    reference_images_count: asFiniteNumber(payload.reference_images_count),
    usable_reference_images_count: asFiniteNumber(payload.usable_reference_images_count),
    nodes: nodesPayload
      .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
      .map((node) => ({
        id: typeof node.id === "string" ? node.id : "",
        label: typeof node.label === "string" ? node.label : "",
        ...(typeof node.instruction === "string" ? { instruction: node.instruction } : {}),
        ...(typeof node.source === "string" ? { source: node.source } : {}),
        covered: node.covered === true,
        matched_units: normalizeStringList(node.matched_units),
      })),
  };
}

function normalizeModelRuleAuditSummary(value: unknown): ProjectArchiveDeliveryReport["model_rule_audit"] {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  return {
    total: asFiniteNumber(payload.total),
    by_mode: normalizeNumberRecord(payload.by_mode),
    by_media_type: normalizeNumberRecord(payload.by_media_type),
    artifact_files: normalizeStringList(payload.artifact_files),
  };
}

function normalizeModelRuleAuditManifest(value: unknown): ProjectArchiveModelRuleAuditManifest | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    format_version: asFiniteNumber(payload.format_version, 1),
    ...(typeof payload.project_name === "string" ? { project_name: payload.project_name } : {}),
    ...(typeof payload.generated_at === "string" ? { generated_at: payload.generated_at } : {}),
    total: asFiniteNumber(payload.total),
    by_mode: normalizeNumberRecord(payload.by_mode),
    by_media_type: normalizeNumberRecord(payload.by_media_type),
    artifact_files: normalizeStringList(payload.artifact_files),
    items: items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => {
        const rule = (item.rule && typeof item.rule === "object")
          ? item.rule as Record<string, unknown>
          : {};
        return {
          task_id: typeof item.task_id === "string" ? item.task_id : "",
          ...(typeof item.task_type === "string" ? { task_type: item.task_type } : {}),
          ...(typeof item.media_type === "string" ? { media_type: item.media_type } : {}),
          ...(typeof item.resource_id === "string" ? { resource_id: item.resource_id } : {}),
          ...(typeof item.script_file === "string" ? { script_file: item.script_file } : {}),
          ...(typeof item.status === "string" ? { status: item.status } : {}),
          ...(typeof item.source === "string" ? { source: item.source } : {}),
          ...(typeof item.queued_at === "string" ? { queued_at: item.queued_at } : {}),
          ...(typeof item.started_at === "string" ? { started_at: item.started_at } : {}),
          ...(typeof item.finished_at === "string" ? { finished_at: item.finished_at } : {}),
          ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {}),
          rule: {
            ...(typeof rule.media_type === "string" ? { media_type: rule.media_type } : {}),
            ...(typeof rule.rule_target === "string" ? { rule_target: rule.rule_target } : {}),
            ...(typeof rule.mode === "string" ? { mode: rule.mode } : {}),
            ...(typeof rule.mode_label === "string" ? { mode_label: rule.mode_label } : {}),
            ...(typeof rule.provider_id === "string" ? { provider_id: rule.provider_id } : {}),
            ...(typeof rule.model_id === "string" ? { model_id: rule.model_id } : {}),
            ...(typeof rule.target_label === "string" ? { target_label: rule.target_label } : {}),
            ...(typeof rule.skill_name === "string" ? { skill_name: rule.skill_name } : {}),
            ...(typeof rule.billing_mode === "string" ? { billing_mode: rule.billing_mode } : {}),
          },
        };
      })
      .filter((item) => item.task_id),
  };
}

function normalizeTravelRouteAssetManifest(value: unknown): TravelRouteAssetManifest | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const route = (payload.route && typeof payload.route === "object")
    ? payload.route as Record<string, unknown>
    : {};
  const coverage = (payload.node_coverage && typeof payload.node_coverage === "object")
    ? payload.node_coverage as Record<string, unknown>
    : {};
  const refs = (payload.reference_images && typeof payload.reference_images === "object")
    ? payload.reference_images as Record<string, unknown>
    : {};
  const refItems = Array.isArray(refs.items) ? refs.items : [];
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const normalizeMatchedUnitDetails = (value: unknown) => {
    const items = Array.isArray(value) ? value : [];
    return items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => {
        const episode = asOptionalFiniteNumber(item.episode);
        return {
          id: typeof item.id === "string" ? item.id : "",
          ...(episode !== undefined ? { episode } : {}),
          ...(typeof item.title === "string" ? { title: item.title } : {}),
          ...(typeof item.script_file === "string" ? { script_file: item.script_file } : {}),
          ...(typeof item.video_clip === "string" ? { video_clip: item.video_clip } : {}),
          ...(typeof item.video_thumbnail === "string" ? { video_thumbnail: item.video_thumbnail } : {}),
          ...(typeof item.status === "string" ? { status: item.status } : {}),
        };
      })
      .filter((item) => item.id);
  };

  return {
    format_version: asFiniteNumber(payload.format_version, 1),
    ...(typeof payload.generated_at === "string" ? { generated_at: payload.generated_at } : {}),
    route: {
      route_ready: route.route_ready === true,
      ...(typeof route.source === "string" ? { source: route.source } : {}),
      ...(typeof route.origin === "string" ? { origin: route.origin } : {}),
      ...(typeof route.destination === "string" ? { destination: route.destination } : {}),
      ...(typeof route.summary === "string" ? { summary: route.summary } : {}),
      ...(typeof route.distance_text === "string" ? { distance_text: route.distance_text } : {}),
      ...(typeof route.duration_text === "string" ? { duration_text: route.duration_text } : {}),
    },
    node_coverage: {
      total: asFiniteNumber(coverage.total),
      covered: asFiniteNumber(coverage.covered),
      missing: normalizeStringList(coverage.missing),
    },
    reference_images: {
      total: asFiniteNumber(refs.total),
      usable: asFiniteNumber(refs.usable),
      items: refItems
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : "",
          path: typeof item.path === "string" ? item.path : "",
          kind: item.kind === "remote" ? "remote" : "local",
          usable: item.usable === true,
          ...(typeof item.archive_path === "string" ? { archive_path: item.archive_path } : {}),
          ...(typeof item.html_src === "string" ? { html_src: item.html_src } : {}),
          used_by_nodes: normalizeStringList(item.used_by_nodes),
        })),
    },
    nodes: nodes
      .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
      .map((node) => ({
        id: typeof node.id === "string" ? node.id : "",
        label: typeof node.label === "string" ? node.label : "",
        ...(typeof node.instruction === "string" ? { instruction: node.instruction } : {}),
        ...(typeof node.source === "string" ? { source: node.source } : {}),
        covered: node.covered === true,
        matched_units: normalizeStringList(node.matched_units),
        matched_unit_details: normalizeMatchedUnitDetails(node.matched_unit_details),
        reference_images: normalizeStringList(node.reference_images),
        ...(typeof node.distance_text === "string" ? { distance_text: node.distance_text } : {}),
        ...(typeof node.duration_text === "string" ? { duration_text: node.duration_text } : {}),
        ...(typeof node.street_view_status === "string" ? { street_view_status: node.street_view_status } : {}),
      })),
  };
}

function normalizeArchiveDeliveryReport(value: unknown): ProjectArchiveDeliveryReport | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const totalsPayload = (payload.totals && typeof payload.totals === "object")
    ? payload.totals as Record<string, unknown>
    : {};
  const episodesPayload = Array.isArray(payload.episodes) ? payload.episodes : [];
  return {
    format_version: asFiniteNumber(payload.format_version, 1),
    status: typeof payload.status === "string" ? payload.status : "ready",
    ...(typeof payload.generated_at === "string" ? { generated_at: payload.generated_at } : {}),
    totals: {
      episodes: asFiniteNumber(totalsPayload.episodes),
      ready_episodes: asFiniteNumber(totalsPayload.ready_episodes),
      scripts_ready: asFiniteNumber(totalsPayload.scripts_ready),
      storyboards_ready: asFiniteNumber(totalsPayload.storyboards_ready),
      storyboards_total: asFiniteNumber(totalsPayload.storyboards_total),
      videos_ready: asFiniteNumber(totalsPayload.videos_ready),
      videos_total: asFiniteNumber(totalsPayload.videos_total),
      blocking_issues: asFiniteNumber(totalsPayload.blocking_issues),
      warnings: asFiniteNumber(totalsPayload.warnings),
    },
    episodes: episodesPayload
      .filter((episode): episode is Record<string, unknown> => Boolean(episode) && typeof episode === "object")
      .map((episode) => ({
        episode: typeof episode.episode === "number" && Number.isFinite(episode.episode)
          ? episode.episode
          : null,
        title: typeof episode.title === "string" ? episode.title : "",
        script_file: typeof episode.script_file === "string" ? episode.script_file : "",
        script_ready: episode.script_ready === true,
        status: typeof episode.status === "string" ? episode.status : "ready",
        storyboards: normalizeDeliveryAssetSummary(episode.storyboards),
        videos: normalizeDeliveryAssetSummary(episode.videos),
        blocking_issues: normalizeDeliveryIssues(episode.blocking_issues),
        warnings: normalizeDeliveryIssues(episode.warnings),
      })),
    travel_route: normalizeTravelRouteDeliveryReport(payload.travel_route),
    model_rule_audit: normalizeModelRuleAuditSummary(payload.model_rule_audit),
  };
}

// ==================== API class ====================

const API_BASE = "/api/v1";

/**
 * 检查 fetch 响应状态，抛出包含后端错误信息的 Error。
 * 用于不经过 API.request() 的自定义 fetch 调用。
 */
async function throwIfNotOk(response: Response, fallbackMsg: string): Promise<void> {
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: response.statusText })) as ErrorResponse;
    handleUnauthorized(response, error.detail);
    const detail = error.detail;
    throw new Error(typeof detail === "string" ? detail || fallbackMsg : fallbackMsg);
  }
}

function isDisabledAccountDetail(detail: unknown): boolean {
  return typeof detail === "string" && detail.trim().toLowerCase() === "user is disabled";
}

function handleUnauthorized(response: Response, detail?: unknown): void {
  if (response.status !== 401 && !(response.status === 403 && isDisabledAccountDetail(detail))) return;

  clearToken();
  globalThis.location.href = "/login";
  throw new Error(response.status === 403 ? "账号已停用，请联系管理员" : "认证已过期，请重新登录");
}

/** 为 fetch options 注入 Authorization header */
function withAuth(options: RequestInit = {}): RequestInit {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  // Add Accept-Language header based on current i18n language
  headers.set("Accept-Language", i18n.language || "zh");
  return { ...options, headers };
}

/** 为 URL 追加 token query param（用于 EventSource） */
function withAuthQuery(url: string): string {
  const token = getToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

class API {
  /**
   * 通用请求方法
   */
  static async request<T = unknown>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${API_BASE}${endpoint}`;
    const defaultOptions: RequestInit = {
      headers: {
        "Content-Type": "application/json",
      },
    };

    const response = await fetch(url, withAuth({ ...defaultOptions, ...options }));

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ detail: response.statusText })) as ErrorResponse;
      handleUnauthorized(response, error.detail);
      let message = "请求失败";
      if (typeof error.detail === "string") {
        message = error.detail;
      } else if (Array.isArray(error.detail) && error.detail.length > 0) {
        message = error.detail.map((e) => (typeof e === "string" ? e : e?.msg)).filter(Boolean).join("; ") || message;
      }
      throw new ApiRequestError(message, response.status, error.detail);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }

  // ==================== 认证 ====================

  static async getAuthCapabilities(): Promise<AuthCapabilitiesResponse> {
    return this.request("/auth/capabilities");
  }

  static async register(payload: RegisterPayload): Promise<LoginResponse> {
    return this.request("/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async verifyAuth(): Promise<VerifyAuthResponse> {
    return this.request("/auth/verify");
  }

  static async searchUsers(query: string, limit: number = 10): Promise<UserSearchItem[]> {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
    });
    return this.request(`/auth/users/search?${params.toString()}`);
  }

  static async listUsers(query: string = "", limit: number = 50): Promise<AdminUserItem[]> {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
    });
    return this.request(`/auth/users?${params.toString()}`);
  }

  static async createUser(payload: CreateUserPayload): Promise<AdminUserItem> {
    return this.request("/auth/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async updateUser(userId: string, payload: UpdateUserPayload): Promise<AdminUserItem> {
    return this.request(`/auth/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  // ==================== 系统配置 ====================

  static async getSystemConfig(): Promise<GetSystemConfigResponse> {
    return this.request("/system/config");
  }

  static async getSystemVersion(): Promise<GetSystemVersionResponse> {
    return this.request("/system/version");
  }

  static async getProjectNamespaceMigrationPreview(): Promise<ProjectNamespaceMigrationResponse> {
    return this.request("/system/project-namespace-migration");
  }

  static async runProjectNamespaceMigration(): Promise<ProjectNamespaceMigrationResponse> {
    return this.request("/system/project-namespace-migration", {
      method: "POST",
    });
  }

  static async updateSystemConfig(
    patch: SystemConfigPatch,
  ): Promise<GetSystemConfigResponse> {
    return this.request("/system/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  static async testMapProvider(
    payload: { provider: "google" | "baidu" | "amap"; api_key?: string },
  ): Promise<MapProviderTestResponse> {
    return this.request("/system/maps/test", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async importGithubSkill(
    payload: { url: string },
  ): Promise<GithubSkillImportResponse> {
    return this.request("/system/model-rules/import-github-skill", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // ==================== 计费与积分 ====================

  static async getCreditBalance(): Promise<CreditBalanceResponse> {
    return this.request("/billing/credits");
  }

  static async getCreditReconciliation(): Promise<CreditReconciliationResponse> {
    return this.request("/billing/credits/reconciliation");
  }

  static async getCreditReconciliationAudits(): Promise<CreditReconciliationAuditsResponse> {
    return this.request("/billing/credits/reconciliation/audits");
  }

  static async runCreditReconciliationAction(
    payload: CreditReconciliationActionPayload,
  ): Promise<CreditReconciliationActionResult> {
    return this.request("/billing/credits/reconciliation/actions", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async addCreditReconciliationNote(
    payload: CreditReconciliationNotePayload,
  ): Promise<CreditReconciliationAudit> {
    return this.request("/billing/credits/reconciliation/notes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async acknowledgeCreditReconciliationIssue(
    payload: CreditReconciliationAcknowledgePayload,
  ): Promise<CreditReconciliationAudit> {
    return this.request("/billing/credits/reconciliation/acknowledgements", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async reopenCreditReconciliationIssue(
    payload: CreditReconciliationReopenPayload,
  ): Promise<CreditReconciliationAudit> {
    return this.request("/billing/credits/reconciliation/reopenings", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async getUserCreditBalance(userId: string): Promise<CreditBalanceResponse> {
    return this.request(`/billing/admin/users/${encodeURIComponent(userId)}/credits`);
  }

  static async getCreditPackages(): Promise<CreditPackagesResponse> {
    return this.request("/billing/credits/packages");
  }

  static async getStripeBillingStatus(): Promise<StripeBillingStatus> {
    return this.request("/billing/stripe/status");
  }

  static async grantCredits(payload: GrantCreditsPayload): Promise<CreditLedgerEntry> {
    return this.request("/billing/credits/grant", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async createCreditOrder(
    payload: CreateCreditOrderPayload,
  ): Promise<CreditOrderResponse> {
    return this.request("/billing/credits/orders", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async getCreditOrder(orderId: string): Promise<CreditLedgerEntry> {
    return this.request(`/billing/credits/orders/${encodeURIComponent(orderId)}`);
  }

  static async cancelCreditOrder(orderId: string): Promise<CreditLedgerEntry> {
    return this.request(`/billing/credits/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
    });
  }

  static async sandboxConfirmCreditOrder(orderId: string): Promise<CreditLedgerEntry> {
    return this.request(`/billing/credits/orders/${encodeURIComponent(orderId)}/sandbox-confirm`, {
      method: "POST",
    });
  }


  // ==================== 项目管理 ====================

  static async listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.request("/projects");
  }

  static async createProject(
    payload: CreateProjectPayload,
  ): Promise<{ success: boolean; name: string; project: ProjectData }> {
    return this.request("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async getProject(
    name: string
  ): Promise<{
    project: ProjectData;
    scripts: Record<string, EpisodeScript>;
    asset_fingerprints?: Record<string, number>;
  }> {
    return this.request(`/projects/${encodeURIComponent(name)}`);
  }

  static async getProjectMembers(name: string): Promise<ProjectMembersResponse> {
    return this.request(`/projects/${encodeURIComponent(name)}/members`);
  }

  static async upsertProjectMember(
    name: string,
    userId: string,
    role: ProjectMemberRole = "editor",
  ): Promise<ProjectMembersResponse> {
    return this.request(`/projects/${encodeURIComponent(name)}/members/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ user_id: userId, role }),
    });
  }

  static async addProjectMember(
    name: string,
    identifier: string,
    role: ProjectMemberRole = "editor",
  ): Promise<ProjectMembersResponse> {
    return this.request(`/projects/${encodeURIComponent(name)}/members`, {
      method: "POST",
      body: JSON.stringify({ identifier, role }),
    });
  }

  static async deleteProjectMember(
    name: string,
    userId: string,
  ): Promise<ProjectMembersResponse> {
    return this.request(`/projects/${encodeURIComponent(name)}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  }

  static async updateProject(
    name: string,
    updates: Partial<ProjectData> & { clear_style_image?: boolean }
  ): Promise<{ success: boolean; project: ProjectData }> {
    if ("content_mode" in updates) {
      throw new Error("项目创建后不支持修改 content_mode");
    }
    return this.request(`/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  static async deleteProject(name: string): Promise<SuccessResponse> {
    return this.request(`/projects/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  static async requestExportToken(
    projectName: string,
    scope: "full" | "current" = "full"
  ): Promise<{
    download_token: string;
    expires_in: number;
    diagnostics: ExportDiagnostics;
    delivery_report: ProjectArchiveDeliveryReport | null;
    travel_route_assets?: TravelRouteAssetManifest | null;
    model_rule_audit?: ProjectArchiveModelRuleAuditManifest | null;
  }> {
    const payload = await this.request<{
      download_token: string;
      expires_in: number;
      diagnostics?: unknown;
      delivery_report?: unknown;
      travel_route_assets?: unknown;
      model_rule_audit?: unknown;
    }>(
      `/projects/${encodeURIComponent(projectName)}/export/token?scope=${encodeURIComponent(scope)}`,
      {
        method: "POST",
      }
    );
    return {
      download_token: payload.download_token,
      expires_in: payload.expires_in,
      diagnostics: normalizeExportDiagnostics(payload.diagnostics),
      delivery_report: normalizeArchiveDeliveryReport(payload.delivery_report),
      travel_route_assets: normalizeTravelRouteAssetManifest(payload.travel_route_assets),
      model_rule_audit: normalizeModelRuleAuditManifest(payload.model_rule_audit),
    };
  }

  static async requestExportPreflight(
    projectName: string,
    scope: "full" | "current" = "full"
  ): Promise<{
    diagnostics: ExportDiagnostics;
    delivery_report: ProjectArchiveDeliveryReport | null;
    travel_route_assets?: TravelRouteAssetManifest | null;
    model_rule_audit?: ProjectArchiveModelRuleAuditManifest | null;
  }> {
    const payload = await this.request<{
      diagnostics?: unknown;
      delivery_report?: unknown;
      travel_route_assets?: unknown;
      model_rule_audit?: unknown;
    }>(
      `/projects/${encodeURIComponent(projectName)}/export/preflight?scope=${encodeURIComponent(scope)}`,
      {
        method: "POST",
      }
    );
    return {
      diagnostics: normalizeExportDiagnostics(payload.diagnostics),
      delivery_report: normalizeArchiveDeliveryReport(payload.delivery_report),
      travel_route_assets: normalizeTravelRouteAssetManifest(payload.travel_route_assets),
      model_rule_audit: normalizeModelRuleAuditManifest(payload.model_rule_audit),
    };
  }

  static getExportDownloadUrl(
    projectName: string,
    downloadToken: string,
    scope: "full" | "current" = "full"
  ): string {
    return `${API_BASE}/projects/${encodeURIComponent(projectName)}/export?download_token=${encodeURIComponent(downloadToken)}&scope=${encodeURIComponent(scope)}`;
  }

  /** 构造剪映草稿下载 URL */
  static getJianyingDraftDownloadUrl(
    projectName: string,
    episode: number,
    draftPath: string,
    downloadToken: string,
    jianyingVersion: string = "6",
  ): string {
    return `${API_BASE}/projects/${encodeURIComponent(projectName)}/export/jianying-draft?episode=${encodeURIComponent(episode)}&draft_path=${encodeURIComponent(draftPath)}&download_token=${encodeURIComponent(downloadToken)}&jianying_version=${encodeURIComponent(jianyingVersion)}`;
  }

  static async importProject(
    file: File,
    conflictPolicy: ImportConflictPolicy = "prompt"
  ): Promise<ImportProjectResponse> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("conflict_policy", conflictPolicy);

    const response = await fetch(
      `${API_BASE}/projects/import`,
      withAuth({
        method: "POST",
        body: formData,
      })
    );

    if (!response.ok) {
      const payload = await response
        .json()
        .catch(() => ({ detail: response.statusText, errors: [], warnings: [] })) as ImportErrorPayload;
      handleUnauthorized(response, payload.detail);
      const error = new Error(
        typeof payload.detail === "string" ? payload.detail : "导入失败"
      ) as Error & {
        status?: number;
        detail?: string;
        errors?: string[];
        warnings?: string[];
        conflict_project_name?: string;
        diagnostics?: ImportFailureDiagnostics;
      };
      error.status = response.status;
      error.detail = typeof payload.detail === "string" ? payload.detail : "导入失败";
      error.errors = Array.isArray(payload.errors) ? payload.errors : [];
      error.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      if (typeof payload.conflict_project_name === "string") {
        error.conflict_project_name = payload.conflict_project_name;
      }
      error.diagnostics = normalizeImportFailureDiagnostics(payload.diagnostics);
      throw error;
    }

    const payload = await response.json() as ImportProjectResponse & { diagnostics?: { auto_fixed?: unknown[]; warnings?: unknown[] } };
    return {
      ...payload,
      diagnostics: {
        auto_fixed: normalizeDiagnosticsBucket(payload?.diagnostics?.auto_fixed),
        warnings: normalizeDiagnosticsBucket(payload?.diagnostics?.warnings),
      },
    };
  }

  // ==================== 角色管理 ====================

  static async addCharacter(
    projectName: string,
    name: string,
    description: string,
    voiceStyle: string = ""
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/characters`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          voice_style: voiceStyle,
        }),
      }
    );
  }

  static async updateCharacter(
    projectName: string,
    charName: string,
    updates: Record<string, unknown>
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/characters/${encodeURIComponent(charName)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      }
    );
  }

  static async deleteCharacter(
    projectName: string,
    charName: string
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/characters/${encodeURIComponent(charName)}`,
      {
        method: "DELETE",
      }
    );
  }

  static async generateProjectCharacters(
    projectName: string
  ): Promise<{
    success: boolean;
    characters: ProjectData["characters"];
    source: "source" | "overview";
    added: number;
    updated: number;
    skipped: number;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate-characters`,
      {
        method: "POST",
      }
    );
  }

  static async generateProjectScenes(
    projectName: string
  ): Promise<{
    success: boolean;
    scenes: NonNullable<ProjectData["scenes"]>;
    source: "source" | "overview";
    added: number;
    updated: number;
    skipped: number;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate-scenes`,
      {
        method: "POST",
      }
    );
  }

  // ==================== 项目场景管理 ====================

  static async addProjectScene(
    projectName: string,
    name: string,
    description: string
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/scenes`,
      {
        method: "POST",
        body: JSON.stringify({ name, description }),
      }
    );
  }

  static async updateProjectScene(
    projectName: string,
    sceneName: string,
    updates: Record<string, unknown>
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/scenes/${encodeURIComponent(sceneName)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      }
    );
  }

  static async deleteProjectScene(
    projectName: string,
    sceneName: string
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/scenes/${encodeURIComponent(sceneName)}`,
      {
        method: "DELETE",
      }
    );
  }

  // ==================== 项目道具管理 ====================

  static async addProjectProp(
    projectName: string,
    name: string,
    description: string
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/props`,
      {
        method: "POST",
        body: JSON.stringify({ name, description }),
      }
    );
  }

  static async updateProjectProp(
    projectName: string,
    propName: string,
    updates: Record<string, unknown>
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/props/${encodeURIComponent(propName)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      }
    );
  }

  static async deleteProjectProp(
    projectName: string,
    propName: string
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/props/${encodeURIComponent(propName)}`,
      {
        method: "DELETE",
      }
    );
  }

  static async generateProjectProps(
    projectName: string
  ): Promise<{
    success: boolean;
    props: NonNullable<ProjectData["props"]>;
    source: "source" | "overview";
    added: number;
    updated: number;
    skipped: number;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate-props`,
      {
        method: "POST",
      }
    );
  }

  static async requestGenerationPreflight(
    projectName: string,
    payload: GenerationPreflightRequest,
  ): Promise<GenerationPreflightResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/preflight`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  static async previewTravelRoute(
    projectName: string,
    travelVideoSettings: TravelVideoSettings,
    options: { persist?: boolean } = {},
  ): Promise<TravelRoutePreview> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/travel-route/preview`,
      {
        method: "POST",
        body: JSON.stringify({
          travel_video_settings: travelVideoSettings,
          persist: options.persist ?? true,
        }),
      },
    );
  }

  static async fetchTravelRouteStreetView(
    projectName: string,
    nodeId: string,
  ): Promise<Blob> {
    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/travel-route/street-view/${encodeURIComponent(nodeId)}`,
      withAuth(),
    );
    await throwIfNotOk(response, "获取街景缩略图失败");
    return response.blob();
  }

  static async generateEpisodeDraft(
    projectName: string,
    episode: number = 1
  ): Promise<{
    success: boolean;
    episode: number;
    title: string;
    script_file: string;
    draft_path: string;
    content: string;
    source: "source" | "overview";
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate-episode-draft`,
      {
        method: "POST",
        body: JSON.stringify({ episode }),
      }
    );
  }

  static async generateEpisodeScript(
    projectName: string,
    episode: number = 1
  ): Promise<{
    success: boolean;
    episode: number;
    script_file: string;
    script: EpisodeScript;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate-episode-script`,
      {
        method: "POST",
        body: JSON.stringify({ episode }),
      }
    );
  }

  // ==================== 场景管理 ====================

  static async getScript(
    projectName: string,
    scriptFile: string
  ): Promise<EpisodeScript> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/scripts/${encodeURIComponent(scriptFile)}`
    );
  }

  static async updateScene(
    projectName: string,
    sceneId: string,
    scriptFile: string,
    updates: Record<string, unknown>
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/scenes/${encodeURIComponent(sceneId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ script_file: scriptFile, updates }),
      }
    );
  }

  // ==================== 片段管理（说书模式） ====================

  static async updateSegment(
    projectName: string,
    segmentId: string,
    updates: Record<string, unknown>
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/segments/${encodeURIComponent(segmentId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      }
    );
  }

  // ==================== 文件管理 ====================

  static async uploadFile(
    projectName: string,
    uploadType: string,
    file: File,
    name: string | null = null,
    options: { onConflict?: "fail" | "replace" | "rename" } = {}
  ): Promise<{
    success: boolean;
    path: string;
    url: string;
    filename?: string;
    normalized?: boolean;
    original_kept?: boolean;
    original_filename?: string;
    used_encoding?: string | null;
    chapter_count?: number;
  }> {
    const formData = new FormData();
    formData.append("file", file);

    const qsParts: string[] = [];
    if (name) qsParts.push(`name=${encodeURIComponent(name)}`);
    if (uploadType === "source" && options.onConflict) {
      qsParts.push(`on_conflict=${encodeURIComponent(options.onConflict)}`);
    }
    const qs = qsParts.join("&");
    const url = `/projects/${encodeURIComponent(projectName)}/upload/${uploadType}${qs ? "?" + qs : ""}`;

    const response = await fetch(`${API_BASE}${url}`, withAuth({
      method: "POST",
      body: formData,
    }));

    if (response.status === 409) {
      let detail: { existing?: string; suggested_name?: string; message?: string } | null = null;
      try {
        const body = (await response.json()) as { detail?: { existing?: string; suggested_name?: string; message?: string } };
        detail = body?.detail ?? null;
      } catch {
        /* ignore */
      }
      // 后端 SourceLoader 的 ConflictError 必然携带 existing + suggested_name；
      // 若 detail 缺字段则视为协议异常，抛通用错误（带文件名标识）而非手搓 fallback —
      // 避免前端"猜"一个可能与后端命名规则不一致的 suggested_name 误导用户
      if (!detail?.existing || !detail?.suggested_name) {
        throw new Error(`上传 "${file.name}" 失败：服务端返回 409 但 detail 字段不完整`);
      }
      throw new ConflictError(
        detail.existing,
        detail.suggested_name,
        detail.message ?? "conflict",
      );
    }

    await throwIfNotOk(response, "上传失败");
    return (await response.json()) as {
      success: boolean;
      path: string;
      url: string;
      filename?: string;
      normalized?: boolean;
      original_kept?: boolean;
      original_filename?: string;
      used_encoding?: string | null;
      chapter_count?: number;
    };
  }

  static async listFiles(
    projectName: string
  ): Promise<{
    files: {
      source?: { name: string; size: number; url: string; raw_filename?: string | null }[];
      characters?: { name: string; size: number; url: string }[];
      scenes?: { name: string; size: number; url: string }[];
      props?: { name: string; size: number; url: string }[];
      storyboards?: { name: string; size: number; url: string }[];
      videos?: { name: string; size: number; url: string }[];
      output?: { name: string; size: number; url: string }[];
    };
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/files`
    );
  }

  static getFileUrl(
    projectName: string,
    path: string,
    cacheBust?: number | string | null
  ): string {
    const base = `${API_BASE}/files/${encodeURIComponent(projectName)}/${path}`;
    if (cacheBust == null || cacheBust === "") {
      return withAuthQuery(base);
    }

    return withAuthQuery(`${base}?v=${encodeURIComponent(String(cacheBust))}`);
  }

  static withAuthQuery(url: string): string {
    return withAuthQuery(url);
  }

  // ==================== Source 文件管理 ====================

  /**
   * 获取 source 文件内容
   */
  static async getSourceContent(
    projectName: string,
    filename: string
  ): Promise<string> {
    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/source/${encodeURIComponent(filename)}`,
      withAuth()
    );
    await throwIfNotOk(response, "获取文件内容失败");
    return response.text();
  }

  /**
   * 保存 source 文件（新建或更新）
   */
  static async saveSourceFile(
    projectName: string,
    filename: string,
    content: string
  ): Promise<SuccessResponse> {
    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/source/${encodeURIComponent(filename)}`,
      withAuth({
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: content,
      })
    );
    await throwIfNotOk(response, "保存文件失败");
    return response.json() as Promise<SuccessResponse>;
  }

  /**
   * 删除 source 文件
   */
  static async deleteSourceFile(
    projectName: string,
    filename: string
  ): Promise<SuccessResponse> {
    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/source/${encodeURIComponent(filename)}`,
      withAuth({
        method: "DELETE",
      })
    );
    await throwIfNotOk(response, "删除文件失败");
    return response.json() as Promise<SuccessResponse>;
  }

  // ==================== 草稿文件管理 ====================

  /**
   * 获取项目的所有草稿
   */
  static async listDrafts(
    projectName: string
  ): Promise<{ drafts: DraftInfo[] }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/drafts`
    );
  }

  /**
   * 获取草稿内容
   */
  static async getDraftContent(
    projectName: string,
    episode: number,
    stepNum: number
  ): Promise<string> {
    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/drafts/${episode}/step${stepNum}`,
      withAuth()
    );
    await throwIfNotOk(response, "获取草稿内容失败");
    return response.text();
  }

  /**
   * 保存草稿内容
   */
  static async saveDraft(
    projectName: string,
    episode: number,
    stepNum: number,
    content: string
  ): Promise<SuccessResponse> {
    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/drafts/${episode}/step${stepNum}`,
      withAuth({
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: content,
      })
    );
    await throwIfNotOk(response, "保存草稿失败");
    return response.json() as Promise<SuccessResponse>;
  }

  /**
   * 删除草稿
   */
  static async deleteDraft(
    projectName: string,
    episode: number,
    stepNum: number
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/drafts/${episode}/step${stepNum}`,
      { method: "DELETE" }
    );
  }

  // ==================== 项目概述管理 ====================

  /**
   * 使用 AI 生成项目概述
   */
  static async generateOverview(
    projectName: string
  ): Promise<{ success: boolean; overview: ProjectOverview }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate-overview`,
      {
        method: "POST",
      }
    );
  }

  /**
   * 更新项目概述（手动编辑）
   */
  static async updateOverview(
    projectName: string,
    updates: Partial<ProjectOverview>
  ): Promise<SuccessResponse> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/overview`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      }
    );
  }

  // ==================== 生成 API ====================

  /**
   * 生成分镜图
   * @param projectName - 项目名称
   * @param segmentId - 片段/场景 ID
   * @param prompt - 图片生成 prompt（支持字符串或结构化对象）
   * @param scriptFile - 剧本文件名
   */
  static async generateStoryboard(
    projectName: string,
    segmentId: string,
    prompt: string | Record<string, unknown>,
    scriptFile: string
  ): Promise<{ success: boolean; task_id: string; message: string }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/storyboard/${encodeURIComponent(segmentId)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt, script_file: scriptFile }),
      }
    );
  }

  /**
   * 生成视频
   * @param projectName - 项目名称
   * @param segmentId - 片段/场景 ID
   * @param prompt - 视频生成 prompt（支持字符串或结构化对象）
   * @param scriptFile - 剧本文件名
   * @param durationSeconds - 时长（秒）
   */
  static async generateVideo(
    projectName: string,
    segmentId: string,
    prompt: string | Record<string, unknown>,
    scriptFile: string,
    durationSeconds: number = 4
  ): Promise<{ success: boolean; task_id: string; message: string }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/video/${encodeURIComponent(segmentId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          prompt,
          script_file: scriptFile,
          duration_seconds: durationSeconds,
        }),
      }
    );
  }

  /**
   * 生成角色设计图
   * @param projectName - 项目名称
   * @param charName - 角色名称
   * @param prompt - 角色描述 prompt
   */
  static async generateCharacter(
    projectName: string,
    charName: string,
    prompt: string
  ): Promise<{
    success: boolean;
    task_id: string;
    message: string;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/character/${encodeURIComponent(charName)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }
    );
  }

  /**
   * 生成场景设计图
   * @param projectName - 项目名称
   * @param sceneName - 场景名称
   * @param prompt - 场景描述 prompt
   */
  static async generateProjectScene(
    projectName: string,
    sceneName: string,
    prompt: string
  ): Promise<{
    success: boolean;
    task_id: string;
    message: string;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/scene/${encodeURIComponent(sceneName)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }
    );
  }

  /**
   * 生成道具设计图
   * @param projectName - 项目名称
   * @param propName - 道具名称
   * @param prompt - 道具描述 prompt
   */
  static async generateProjectProp(
    projectName: string,
    propName: string,
    prompt: string
  ): Promise<{
    success: boolean;
    task_id: string;
    message: string;
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/prop/${encodeURIComponent(propName)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }
    );
  }

  // ==================== 任务队列 API ====================

  static async getTask(taskId: string): Promise<TaskItem> {
    const response = await this.request<{ task: TaskItem }>(`/tasks/${encodeURIComponent(taskId)}`);
    return response.task;
  }

  static async listTasks(
    filters: TaskListFilters = {}
  ): Promise<{ items: TaskItem[]; total: number; page: number; page_size: number }> {
    const params = new URLSearchParams();
    if (filters.projectName) params.append("project_name", filters.projectName);
    if (filters.status) params.append("status", filters.status);
    if (filters.taskType) params.append("task_type", filters.taskType);
    if (filters.source) params.append("source", filters.source);
    if (filters.page) params.append("page", String(filters.page));
    if (filters.pageSize) params.append("page_size", String(filters.pageSize));
    const query = params.toString();
    return this.request(`/tasks${query ? "?" + query : ""}`);
  }

  static async listProjectTasks(
    projectName: string,
    filters: Omit<TaskListFilters, "projectName"> = {}
  ): Promise<{ items: TaskItem[]; total: number; page: number; page_size: number }> {
    const params = new URLSearchParams();
    if (filters.status) params.append("status", filters.status);
    if (filters.taskType) params.append("task_type", filters.taskType);
    if (filters.source) params.append("source", filters.source);
    if (filters.page) params.append("page", String(filters.page));
    if (filters.pageSize) params.append("page_size", String(filters.pageSize));
    const query = params.toString();
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/tasks${query ? "?" + query : ""}`
    );
  }

  static async getTaskStats(
    projectName: string | null = null
  ): Promise<{ stats: TaskStats }> {
    const params = new URLSearchParams();
    if (projectName) params.append("project_name", projectName);
    const query = params.toString();
    return this.request(`/tasks/stats${query ? "?" + query : ""}`);
  }

  // ==================== 任务取消 API ====================

  static async cancelPreview(
    taskId: string
  ): Promise<{ task: { task_id: string; task_type: string; resource_id: string }; cascaded: { task_id: string; task_type: string; resource_id: string }[] }> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/cancel-preview`);
  }

  static async cancelTask(
    taskId: string
  ): Promise<{ cancelled: TaskItem[]; skipped_running: TaskItem[] }> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  }

  static async retryTask(
    taskId: string
  ): Promise<{ task_id: string; status: string; deduped: boolean; existing_task_id: string | null }> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST",
    });
  }

  static async cancelAllPreview(
    projectName: string
  ): Promise<{ queued_count: number }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/tasks/cancel-all-preview`
    );
  }

  static async cancelAllQueued(
    projectName: string
  ): Promise<{ cancelled_count: number; skipped_running_count: number }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/tasks/cancel-all`,
      { method: "POST" }
    );
  }

  static openTaskStream(options: TaskStreamOptions = {}): EventSource {
    const params = new URLSearchParams();
    if (options.projectName)
      params.append("project_name", options.projectName);
    const parsedLastEventId = Number(options.lastEventId);
    if (Number.isFinite(parsedLastEventId) && parsedLastEventId > 0) {
      params.append("last_event_id", String(parsedLastEventId));
    }

    const query = params.toString();
    const url = withAuthQuery(`${API_BASE}/tasks/stream${query ? "?" + query : ""}`);
    const source = new EventSource(url);

    const parsePayload = (event: MessageEvent): unknown => {
      try {
        return JSON.parse((event.data as string) || "{}");
      } catch (err) {
        console.error("解析 SSE 数据失败:", err, event.data);
        return null;
      }
    };

    source.addEventListener("snapshot", (event) => {
      const payload = parsePayload(event);
      if (payload && typeof options.onSnapshot === "function") {
        options.onSnapshot(
          payload as TaskStreamSnapshotPayload,
          event
        );
      }
    });

    source.addEventListener("task", (event) => {
      const payload = parsePayload(event);
      if (payload && typeof options.onTask === "function") {
        options.onTask(
          payload as TaskStreamTaskPayload,
          event
        );
      }
    });

    source.onerror = (event: Event) => {
      if (typeof options.onError === "function") {
        options.onError(event);
      }
    };

    return source;
  }

  static openProjectEventStream(options: ProjectEventStreamOptions): EventSource {
    const url = withAuthQuery(
      `${API_BASE}/projects/${encodeURIComponent(options.projectName)}/events/stream`
    );
    const source = new EventSource(url);

    const parsePayload = (event: MessageEvent): unknown => {
      try {
        return JSON.parse((event.data as string) || "{}");
      } catch (err) {
        console.error("解析项目事件 SSE 数据失败:", err, event.data);
        return null;
      }
    };

    const createHandler = <T>(
      callback?: (payload: T, event: MessageEvent) => void
    ) => {
      return (event: Event) => {
        if (typeof callback !== "function") return;
        const payload = parsePayload(event as MessageEvent);
        if (payload) {
          callback(payload as T, event as MessageEvent);
        }
      };
    };

    source.addEventListener("snapshot", createHandler(options.onSnapshot));
    source.addEventListener("changes", createHandler(options.onChanges));

    source.onerror = (event: Event) => {
      if (typeof options.onError === "function") {
        options.onError(event);
      }
    };

    return source;
  }

  // ==================== 版本管理 API ====================

  /**
   * 获取资源版本列表
   * @param projectName - 项目名称
   * @param resourceType - 资源类型 (storyboards, videos, characters, scenes, props)
   * @param resourceId - 资源 ID
   */
  static async getVersions(
    projectName: string,
    resourceType: string,
    resourceId: string
  ): Promise<{
    resource_type: string;
    resource_id: string;
    current_version: number;
    versions: VersionInfo[];
  }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/versions/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`
    );
  }

  /**
   * 还原到指定版本
   * @param projectName - 项目名称
   * @param resourceType - 资源类型
   * @param resourceId - 资源 ID
   * @param version - 要还原的版本号
   */
  static async restoreVersion(
    projectName: string,
    resourceType: string,
    resourceId: string,
    version: number
  ): Promise<SuccessResponse & { file_path?: string; asset_fingerprints?: Record<string, number> }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/versions/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/restore/${version}`,
      {
        method: "POST",
      }
    );
  }

  // ==================== 风格参考图 API ====================

  /**
   * 上传风格参考图
   * @param projectName - 项目名称
   * @param file - 图片文件
   * @returns 包含 style_image, style_description, url 的结果
   */
  static async uploadStyleImage(
    projectName: string,
    file: File
  ): Promise<{
    success: boolean;
    style_image: string;
    style_description: string;
    url: string;
  }> {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(projectName)}/style-image`,
      withAuth({
        method: "POST",
        body: formData,
      })
    );

    await throwIfNotOk(response, "上传失败");

    return response.json() as Promise<{ success: boolean; style_image: string; style_description: string; url: string }>;
  }

  // ==================== 助手会话 API ====================

  /** Build the project-scoped assistant base path. */
  private static assistantBase(projectName: string): string {
    return `/projects/${encodeURIComponent(projectName)}/assistant`;
  }

  static async listAssistantSessions(
    projectName: string,
    status: string | null = null
  ): Promise<{ sessions: SessionMeta[] }> {
    const params = new URLSearchParams();
    if (status) params.append("status", status);
    const query = params.toString();
    return this.request(
      `${this.assistantBase(projectName)}/sessions${query ? "?" + query : ""}`
    );
  }

  static async getAssistantSession(
    projectName: string,
    sessionId: string
  ): Promise<{ session: SessionMeta }> {
    return this.request(
      `${this.assistantBase(projectName)}/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  static async getAssistantSnapshot(
    projectName: string,
    sessionId: string
  ): Promise<AssistantSnapshot> {
    return this.request(
      `${this.assistantBase(projectName)}/sessions/${encodeURIComponent(sessionId)}/snapshot`
    );
  }

  static async sendAssistantMessage(
    projectName: string,
    content: string,
    sessionId?: string | null,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<{ session_id: string; status: string }> {
    return this.request(`${this.assistantBase(projectName)}/sessions/send`, {
      method: "POST",
      body: JSON.stringify({
        content,
        session_id: sessionId || undefined,
        images: images || [],
      }),
    });
  }

  static async interruptAssistantSession(
    projectName: string,
    sessionId: string
  ): Promise<SuccessResponse> {
    return this.request(
      `${this.assistantBase(projectName)}/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: "POST",
      }
    );
  }

  static async answerAssistantQuestion(
    projectName: string,
    sessionId: string,
    questionId: string,
    answers: Record<string, string>
  ): Promise<SuccessResponse> {
    return this.request(
      `${this.assistantBase(projectName)}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/answer`,
      {
        method: "POST",
        body: JSON.stringify({ answers }),
      }
    );
  }

  static getAssistantStreamUrl(projectName: string, sessionId: string): string {
    return withAuthQuery(`${API_BASE}${this.assistantBase(projectName)}/sessions/${encodeURIComponent(sessionId)}/stream`);
  }

  static async listAssistantSkills(
    projectName: string
  ): Promise<{ skills: SkillInfo[] }> {
    return this.request(
      `${this.assistantBase(projectName)}/skills`
    );
  }

  static async deleteAssistantSession(
    projectName: string,
    sessionId: string
  ): Promise<SuccessResponse> {
    return this.request(
      `${this.assistantBase(projectName)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
      }
    );
  }

  // ==================== 费用统计 API ====================

  /**
   * 获取统计摘要
   * @param filters - 筛选条件
   */
  static async getUsageStats(
    filters: UsageStatsFilters = {}
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (filters.projectName)
      params.append("project_name", filters.projectName);
    if (filters.startDate) params.append("start_date", filters.startDate);
    if (filters.endDate) params.append("end_date", filters.endDate);
    const query = params.toString();
    return this.request(`/usage/stats${query ? "?" + query : ""}`);
  }

  /**
   * 获取调用记录列表
   * @param filters - 筛选条件
   */
  static async getUsageCalls(
    filters: UsageCallsFilters = {}
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (filters.projectName)
      params.append("project_name", filters.projectName);
    if (filters.callType) params.append("call_type", filters.callType);
    if (filters.status) params.append("status", filters.status);
    if (filters.startDate) params.append("start_date", filters.startDate);
    if (filters.endDate) params.append("end_date", filters.endDate);
    if (filters.page) params.append("page", String(filters.page));
    if (filters.pageSize) params.append("page_size", String(filters.pageSize));
    const query = params.toString();
    return this.request(`/usage/calls${query ? "?" + query : ""}`);
  }

  /**
   * 获取有调用记录的项目列表
   */
  static async getUsageProjects(): Promise<{ projects: string[] }> {
    return this.request("/usage/projects");
  }

  // ==================== API Key 管理 API ====================

  /** 列出所有 API Key（不含完整 key）。 */
  static async listApiKeys(): Promise<ApiKeyInfo[]> {
    return this.request("/api-keys");
  }

  /** 创建新 API Key，返回含完整 key 的响应（仅此一次）。 */
  static async createApiKey(name: string, expiresDays?: number): Promise<CreateApiKeyResponse> {
    return this.request("/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, expires_days: expiresDays ?? null }),
    });
  }

  /** 删除（吊销）指定 API Key。 */
  static async deleteApiKey(keyId: number): Promise<void> {
    return this.request(`/api-keys/${keyId}`, { method: "DELETE" });
  }

  // ==================== Provider 管理 API ====================

  /** 获取所有 provider 列表及状态。 */
  static async getProviders(): Promise<{ providers: ProviderInfo[] }> {
    return this.request("/providers");
  }

  /** 获取指定 provider 的配置详情（含字段列表）。 */
  static async getProviderConfig(id: string): Promise<ProviderConfigDetail> {
    return this.request(`/providers/${encodeURIComponent(id)}/config`);
  }

  /** 更新指定 provider 的配置字段。 */
  static async patchProviderConfig(
    id: string,
    patch: Record<string, string | null>
  ): Promise<void> {
    return this.request(`/providers/${encodeURIComponent(id)}/config`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** 测试指定 provider 的连接。 */
  static async testProviderConnection(
    id: string,
    credentialId?: number,
    draft?: { api_key?: string; base_url?: string },
  ): Promise<ProviderTestResult> {
    const params = credentialId != null ? `?credential_id=${credentialId}` : "";
    return this.request(`/providers/${encodeURIComponent(id)}/test${params}`, {
      method: "POST",
      body: draft ? JSON.stringify(draft) : undefined,
    });
  }

  // ==================== Provider 凭证管理 API ====================

  static async listCredentials(providerId: string): Promise<{ credentials: ProviderCredential[] }> {
    return this.request(`/providers/${encodeURIComponent(providerId)}/credentials`);
  }

  static async createCredential(
    providerId: string,
    data: { name: string; api_key?: string; base_url?: string },
  ): Promise<ProviderCredential> {
    return this.request(`/providers/${encodeURIComponent(providerId)}/credentials`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  static async updateCredential(
    providerId: string,
    credId: number,
    data: { name?: string; api_key?: string; base_url?: string },
  ): Promise<void> {
    return this.request(
      `/providers/${encodeURIComponent(providerId)}/credentials/${credId}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
  }

  static async deleteCredential(providerId: string, credId: number): Promise<void> {
    return this.request(
      `/providers/${encodeURIComponent(providerId)}/credentials/${credId}`,
      { method: "DELETE" },
    );
  }

  static async activateCredential(providerId: string, credId: number): Promise<void> {
    return this.request(
      `/providers/${encodeURIComponent(providerId)}/credentials/${credId}/activate`,
      { method: "POST" },
    );
  }

  static async uploadVertexCredential(name: string, file: File): Promise<ProviderCredential> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(
      `${API_BASE}/providers/gemini-vertex/credentials/upload?name=${encodeURIComponent(name)}`,
      withAuth({ method: "POST", body: formData }),
    );
    await throwIfNotOk(response, "上传凭证失败");
    return response.json() as Promise<ProviderCredential>;
  }

  // ==================== 自定义供应商 API ====================

  static async listCustomProviders(): Promise<{ providers: CustomProviderInfo[] }> {
    return this.request("/custom-providers");
  }

  static async createCustomProvider(data: CustomProviderCreateRequest): Promise<CustomProviderInfo> {
    return this.request("/custom-providers", { method: "POST", body: JSON.stringify(data) });
  }

  static async getCustomProvider(id: number): Promise<CustomProviderInfo> {
    return this.request(`/custom-providers/${id}`);
  }

  static async updateCustomProvider(id: number, data: Partial<Omit<CustomProviderCreateRequest, "discovery_format" | "models">>): Promise<void> {
    return this.request(`/custom-providers/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }

  static async fullUpdateCustomProvider(id: number, data: { display_name: string; base_url: string; api_key?: string; models: CustomProviderModelInput[] }): Promise<CustomProviderInfo> {
    return this.request(`/custom-providers/${id}`, { method: "PUT", body: JSON.stringify(data) });
  }

  static async deleteCustomProvider(id: number): Promise<void> {
    return this.request(`/custom-providers/${id}`, { method: "DELETE" });
  }

  static async replaceCustomProviderModels(id: number, models: CustomProviderModelInput[]): Promise<CustomProviderModelInfo[]> {
    return this.request(`/custom-providers/${id}/models`, { method: "PUT", body: JSON.stringify({ models }) });
  }

  static async discoverModels(data: { discovery_format: string; base_url: string; api_key: string }): Promise<{ models: DiscoveredModel[] }> {
    return this.request("/custom-providers/discover", { method: "POST", body: JSON.stringify(data) });
  }

  static async discoverModelsForProvider(id: number): Promise<{ models: DiscoveredModel[] }> {
    return this.request(`/custom-providers/${id}/discover`, { method: "POST" });
  }

  static async testCustomConnection(data: { discovery_format: string; base_url: string; api_key: string }): Promise<{ success: boolean; message: string }> {
    return this.request("/custom-providers/test", { method: "POST", body: JSON.stringify(data) });
  }

  static async testCustomConnectionById(id: number): Promise<{ success: boolean; message: string }> {
    return this.request(`/custom-providers/${id}/test`, { method: "POST" });
  }

  // ==================== 用量统计（按 provider 分组）API ====================

  /**
   * 获取按 provider 分组的用量统计。
   * @param params - 可选筛选：provider、start、end（ISO 日期字符串）
   */
  static async getUsageStatsGrouped(
    params: { provider?: string; start?: string; end?: string } = {}
  ): Promise<UsageStatsResponse> {
    const searchParams = new URLSearchParams();
    searchParams.append("group_by", "provider");
    if (params.provider) searchParams.append("provider", params.provider);
    if (params.start) searchParams.append("start_date", params.start);
    if (params.end) searchParams.append("end_date", params.end);
    return this.request(`/usage/stats?${searchParams.toString()}`);
  }

  // ==================== 费用估算 API ====================

  /**
   * 获取项目费用估算。
   * @param projectName - 项目名称
   */
  static async getCostEstimate(projectName: string): Promise<CostEstimateResponse> {
    return this.request(`/projects/${encodeURIComponent(projectName)}/cost-estimate`);
  }

  // ==================== Grid 图生视频 API ====================

  /**
   * 生成 Grid 图像（多场景网格）
   * @param projectName - 项目名称
   * @param episode - 剧集编号
   * @param scriptFile - 剧本文件名
   * @param sceneIds - 可选，指定场景 ID 列表
   */
  static async generateGrid(
    projectName: string,
    episode: number,
    scriptFile: string,
    sceneIds?: string[]
  ): Promise<{ success: boolean; grid_ids: string[]; task_ids: string[]; message: string }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/generate/grid/${episode}`,
      { method: "POST", body: JSON.stringify({ script_file: scriptFile, scene_ids: sceneIds }) }
    );
  }

  /**
   * 列出项目所有 Grid 记录
   * @param projectName - 项目名称
   */
  static async listGrids(projectName: string): Promise<GridGeneration[]> {
    return this.request(`/projects/${encodeURIComponent(projectName)}/grids`);
  }

  /**
   * 获取单个 Grid 详情
   * @param projectName - 项目名称
   * @param gridId - Grid ID
   */
  static async getGrid(projectName: string, gridId: string): Promise<GridGeneration> {
    return this.request(`/projects/${encodeURIComponent(projectName)}/grids/${encodeURIComponent(gridId)}`);
  }

  /**
   * 重新生成 Grid 图像
   * @param projectName - 项目名称
   * @param gridId - Grid ID
   */
  static async regenerateGrid(
    projectName: string,
    gridId: string
  ): Promise<{ success: boolean; task_id: string }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/grids/${encodeURIComponent(gridId)}/regenerate`,
      { method: "POST" }
    );
  }

  // ==================== Global Asset Library ====================

  static async listAssets(
    params: { type?: AssetType; q?: string; limit?: number; offset?: number } = {},
    options: RequestInit = {},
  ) {
    const usp = new URLSearchParams();
    if (params.type) usp.set("type", params.type);
    if (params.q) usp.set("q", params.q);
    if (params.limit) usp.set("limit", String(params.limit));
    if (params.offset) usp.set("offset", String(params.offset));
    return this.request<{ items: Asset[] }>(`/assets?${usp.toString()}`, options);
  }

  static async getAsset(id: string) {
    return this.request<{ asset: Asset }>(`/assets/${encodeURIComponent(id)}`);
  }

  static async createAsset(payload: AssetCreatePayload & { image?: File }) {
    const form = new FormData();
    form.append("type", payload.type);
    form.append("name", payload.name);
    form.append("description", payload.description ?? "");
    form.append("voice_style", payload.voice_style ?? "");
    if (payload.image) form.append("image", payload.image);
    const url = `${API_BASE}/assets`;
    const response = await fetch(url, withAuth({ method: "POST", body: form }));
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ detail: response.statusText }))) as {
        detail?: string;
      };
      handleUnauthorized(response, error.detail);
      throw new Error(typeof error.detail === "string" ? error.detail : "请求失败");
    }
    return response.json() as Promise<{ asset: Asset }>;
  }

  static async updateAsset(id: string, patch: AssetUpdatePayload) {
    return this.request<{ asset: Asset }>(`/assets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  static async replaceAssetImage(id: string, image: File) {
    const form = new FormData();
    form.append("image", image);
    const url = `${API_BASE}/assets/${encodeURIComponent(id)}/image`;
    const response = await fetch(url, withAuth({ method: "POST", body: form }));
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ detail: response.statusText }))) as {
        detail?: string;
      };
      handleUnauthorized(response, error.detail);
      throw new Error(typeof error.detail === "string" ? error.detail : "请求失败");
    }
    return response.json() as Promise<{ asset: Asset }>;
  }

  static async deleteAsset(id: string): Promise<void> {
    return this.request(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  static async addAssetFromProject(payload: {
    project_name: string;
    resource_type: AssetType;
    resource_id: string;
    override_name?: string;
    overwrite?: boolean;
  }) {
    return this.request<{ asset: Asset }>(`/assets/from-project`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async addAssetFromProjectFile(payload: {
    project_name: string;
    file_path: string;
    asset_type?: AssetType;
    name?: string;
    description?: string;
    voice_style?: string;
    conflict_policy?: "skip" | "overwrite" | "rename";
  }) {
    return this.request<{ asset: Asset }>(`/assets/from-project-file`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async applyAssetsToProject(payload: {
    asset_ids: string[];
    target_project: string;
    conflict_policy: "skip" | "overwrite" | "rename";
  }) {
    return this.request<{
      succeeded: Array<{ id: string; name: string }>;
      skipped: Array<{ id: string; name: string }>;
      failed: Array<{ id: string; reason: string }>;
    }>(`/assets/apply-to-project`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static getGlobalAssetUrl(path: string | null, fp?: string | null): string | null {
    if (!path) return null;
    const parts = path.split("/");
    if (parts.length < 3 || parts[0] !== "_global_assets") return null;
    const type = parts[1];
    const filename = parts.slice(2).join("/");
    const qs = fp ? `?fp=${encodeURIComponent(fp)}` : "";
    return `${API_BASE}/global-assets/${type}/${filename}${qs}`;
  }

  // ==================== Reference-to-Video API ====================

  /** List reference-video units for an episode. */
  static async listReferenceVideoUnits(
    projectName: string,
    episode: number,
  ): Promise<{ units: ReferenceVideoUnit[] }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/reference-videos/episodes/${episode}/units`,
    );
  }

  /** Create a new reference-video unit. */
  static async addReferenceVideoUnit(
    projectName: string,
    episode: number,
    payload: {
      prompt: string;
      references: ReferenceResource[];
      duration_seconds?: number;
      transition_to_next?: TransitionType;
      note?: string | null;
    },
  ): Promise<{ unit: ReferenceVideoUnit }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/reference-videos/episodes/${episode}/units`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  /** Patch prompt/references/duration/transition/note on an existing unit. */
  static async patchReferenceVideoUnit(
    projectName: string,
    episode: number,
    unitId: string,
    patch: {
      prompt?: string;
      references?: ReferenceResource[];
      duration_seconds?: number;
      transition_to_next?: TransitionType;
      note?: string | null;
    },
  ): Promise<{ unit: ReferenceVideoUnit }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/reference-videos/episodes/${episode}/units/${encodeURIComponent(unitId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  /** Delete a unit. Returns void on 204. */
  static async deleteReferenceVideoUnit(
    projectName: string,
    episode: number,
    unitId: string,
  ): Promise<void> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/reference-videos/episodes/${episode}/units/${encodeURIComponent(unitId)}`,
      { method: "DELETE" },
    );
  }

  /** Reorder units by providing the full ordered unit_id list. */
  static async reorderReferenceVideoUnits(
    projectName: string,
    episode: number,
    unitIds: string[],
  ): Promise<{ units: ReferenceVideoUnit[] }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/reference-videos/episodes/${episode}/units/reorder`,
      { method: "POST", body: JSON.stringify({ unit_ids: unitIds }) },
    );
  }

  /** Enqueue generation; returns 202 with task_id. */
  static async generateReferenceVideoUnit(
    projectName: string,
    episode: number,
    unitId: string,
  ): Promise<{ task_id: string; deduped: boolean }> {
    return this.request(
      `/projects/${encodeURIComponent(projectName)}/reference-videos/episodes/${episode}/units/${encodeURIComponent(unitId)}/generate`,
      { method: "POST" },
    );
  }
}

export { API };
