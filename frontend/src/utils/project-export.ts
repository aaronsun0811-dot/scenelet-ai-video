import { API } from "@/api";
import type {
  ExportDiagnostics,
  ProjectArchiveDeliveryReport,
  ProjectArchiveModelRuleAuditManifest,
  TravelRouteAssetManifest,
} from "@/types";

export type ProjectExportScope = "current" | "full";

export interface ProjectExportDownloadResult {
  diagnostics: ExportDiagnostics;
  deliveryReport: ProjectArchiveDeliveryReport | null;
  travelRouteAssets: TravelRouteAssetManifest | null;
  modelRuleAudit: ProjectArchiveModelRuleAuditManifest | null;
}

export interface ProjectExportPreflightResult extends ProjectExportDownloadResult {
  scope: ProjectExportScope;
}

export interface PreparedProjectExport extends ProjectExportPreflightResult {
  downloadToken: string;
  expiresIn: number;
}

export function triggerBrowserDownload(url: string, downloadName?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (downloadName) {
    a.download = downloadName;
  }
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function countExportDiagnostics(diagnostics: ExportDiagnostics): number {
  return diagnostics.blocking.length + diagnostics.auto_fixed.length + diagnostics.warnings.length;
}

export function countDeliveryReportAlerts(report: ProjectArchiveDeliveryReport | null | undefined): number {
  if (!report) return 0;
  return report.totals.blocking_issues + report.totals.warnings;
}

export function countProjectExportAlerts(result: ProjectExportDownloadResult): number {
  return countExportDiagnostics(result.diagnostics) + countDeliveryReportAlerts(result.deliveryReport);
}

export function countProjectExportPreflightIssues(result: ProjectExportDownloadResult): number {
  return result.diagnostics.blocking.length +
    result.diagnostics.warnings.length +
    countDeliveryReportAlerts(result.deliveryReport);
}

export function hasTravelRouteAssetManifest(result: ProjectExportDownloadResult): boolean {
  return Boolean(result.travelRouteAssets || result.deliveryReport?.travel_route);
}

export function shouldShowProjectExportPreflightDialog(result: ProjectExportDownloadResult): boolean {
  return countProjectExportPreflightIssues(result) > 0 || hasTravelRouteAssetManifest(result);
}

export function firstDeliveryReportIssueEpisode(
  report: ProjectArchiveDeliveryReport | null | undefined,
): number | null {
  const issue = report?.episodes.find((episode) =>
    episode.episode !== null &&
    (episode.blocking_issues.length > 0 || episode.warnings.length > 0)
  );
  return issue?.episode ?? null;
}

export function serializeDeliveryReportJson(report: ProjectArchiveDeliveryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function getDeliveryReportTimestampPart(generatedAt: string | undefined): string | null {
  if (!generatedAt?.trim()) return null;

  const value = generatedAt.trim();
  const isoParts = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (isoParts) {
    return `${isoParts[1]}${isoParts[2]}${isoParts[3]}-${isoParts[4]}${isoParts[5]}${isoParts[6] ?? "00"}`;
  }

  const asciiTimestamp = value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return asciiTimestamp || "generated";
}

export function getDeliveryReportDownloadBaseName(
  report: ProjectArchiveDeliveryReport,
  contextName?: string | null,
): string {
  const parts = ["scenelet-delivery-report"];
  const context = contextName ? sanitizeFilenamePart(contextName) : "";
  if (context) parts.push(context);

  const timestamp = getDeliveryReportTimestampPart(report.generated_at);
  if (timestamp) parts.push(timestamp);

  return parts.join("-");
}

function renderCounterSummary(
  counts: Record<string, number>,
  labeler: (value: string) => string,
): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => Number.isFinite(count))
    .map(([key, count]) => `${labeler(key)} ${count}`);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function modelRuleModeLabel(mode: string): string {
  return {
    default: "默认规则",
    prompt: "Prompt",
    github_skill: "GitHub Skill",
    uploaded_skill: "上传 Skill",
  }[mode] ?? (mode || "未知");
}

function modelRuleMediaLabel(mediaType: string): string {
  return {
    image: "图片",
    video: "视频",
    text: "文本",
  }[mediaType] ?? (mediaType || "未知");
}

export function renderDeliveryReportMarkdown(report: ProjectArchiveDeliveryReport): string {
  const statusLabel = {
    ready: "可交付",
    ready_with_warnings: "可交付（有提醒）",
    needs_work: "需处理",
  }[report.status] ?? report.status;
  const lines = [
    "# Scenelet 交付检查报告",
    "",
    `- 交付状态: ${statusLabel}`,
    `- 生成时间: ${report.generated_at ?? "-"}`,
    `- 分集: ${report.totals.ready_episodes} / ${report.totals.episodes}`,
    `- 剧本: ${report.totals.scripts_ready} / ${report.totals.episodes}`,
    `- 分镜/宫格: ${report.totals.storyboards_ready} / ${report.totals.storyboards_total}`,
    `- 视频: ${report.totals.videos_ready} / ${report.totals.videos_total}`,
    `- 阻断项: ${report.totals.blocking_issues}`,
    `- 提醒项: ${report.totals.warnings}`,
    "",
  ];

  if (report.travel_route) {
    const route = report.travel_route;
    const routeStatus = route.route_ready ? "已预检" : "未通过/未预检";
    lines.push("## 旅游路线检查");
    lines.push("");
    lines.push(`- 路线状态: ${routeStatus}`);
    lines.push(`- 路线摘要: ${route.summary ?? "-"}`);
    lines.push(`- 出发地 / 目的地: ${route.origin ?? "-"} / ${route.destination ?? "-"}`);
    lines.push(`- 路线距离 / 预计时长: ${route.distance_text ?? "-"} / ${route.duration_text ?? "-"}`);
    lines.push(`- 路线节点覆盖: ${route.nodes_covered} / ${route.nodes_total}`);
    lines.push(`- 参考图数量: ${route.usable_reference_images_count} / ${route.reference_images_count} 可用`);
    const missingNodes = route.nodes.filter((node) => !node.covered);
    if (missingNodes.length > 0) {
      lines.push(`- 未覆盖节点: ${missingNodes.map((node) => node.label || node.id).slice(0, 6).join(", ")}`);
    }
    lines.push("");
  }

  if (report.model_rule_audit) {
    lines.push("## 模型规则审计");
    lines.push("");
    lines.push(`- 记录任务: ${report.model_rule_audit.total}`);
    lines.push(`- 规则来源: ${renderCounterSummary(report.model_rule_audit.by_mode, modelRuleModeLabel)}`);
    lines.push(`- 媒体类型: ${renderCounterSummary(report.model_rule_audit.by_media_type, modelRuleMediaLabel)}`);
    if (report.model_rule_audit.artifact_files.length > 0) {
      lines.push(`- 审计文件: ${report.model_rule_audit.artifact_files.join(" / ")}`);
    }
    lines.push("");
  }

  lines.push("## 分集明细");
  lines.push("");

  for (const episode of report.episodes) {
    lines.push(`### E${episode.episode ?? "?"} ${episode.title}`);
    lines.push(`- 状态: ${episode.status}`);
    lines.push(`- 剧本: ${episode.script_ready ? "已齐" : "缺失"}`);
    lines.push(`- 分镜/宫格: ${episode.storyboards.ready} / ${episode.storyboards.total}`);
    lines.push(`- 视频: ${episode.videos.ready} / ${episode.videos.total}`);
    const issues = [
      ...episode.blocking_issues.map((issue) => ["阻断", issue] as const),
      ...episode.warnings.map((issue) => ["提醒", issue] as const),
    ];
    if (issues.length === 0) {
      lines.push("- 检查: 通过");
    } else {
      for (const [label, issue] of issues) {
        const itemText = issue.items && issue.items.length > 0 ? ` (${issue.items.join(", ")})` : "";
        lines.push(`- ${label}: ${issue.message}${itemText}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  triggerBrowserDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadDeliveryReportJson(report: ProjectArchiveDeliveryReport, contextName?: string | null) {
  downloadTextFile(
    `${getDeliveryReportDownloadBaseName(report, contextName)}.json`,
    serializeDeliveryReportJson(report),
    "application/json;charset=utf-8",
  );
}

export function downloadDeliveryReportMarkdown(report: ProjectArchiveDeliveryReport, contextName?: string | null) {
  downloadTextFile(
    `${getDeliveryReportDownloadBaseName(report, contextName)}.md`,
    renderDeliveryReportMarkdown(report),
    "text/markdown;charset=utf-8",
  );
}

export async function prepareProjectExport(
  projectName: string,
  scope: ProjectExportScope = "current",
): Promise<PreparedProjectExport> {
  const { download_token, expires_in, diagnostics, delivery_report, travel_route_assets, model_rule_audit } = await API.requestExportToken(projectName, scope);
  return {
    downloadToken: download_token,
    expiresIn: expires_in,
    scope,
    diagnostics,
    deliveryReport: delivery_report,
    travelRouteAssets: travel_route_assets ?? null,
    modelRuleAudit: model_rule_audit ?? null,
  };
}

export async function loadProjectExportPreflight(
  projectName: string,
  scope: ProjectExportScope = "current",
): Promise<ProjectExportPreflightResult> {
  const { diagnostics, delivery_report, travel_route_assets, model_rule_audit } = await API.requestExportPreflight(projectName, scope);
  return {
    scope,
    diagnostics,
    deliveryReport: delivery_report,
    travelRouteAssets: travel_route_assets ?? null,
    modelRuleAudit: model_rule_audit ?? null,
  };
}

export function triggerPreparedProjectDownload(projectName: string, prepared: PreparedProjectExport) {
  triggerBrowserDownload(API.getExportDownloadUrl(projectName, prepared.downloadToken, prepared.scope));
}

export async function downloadProjectZip(
  projectName: string,
  scope: ProjectExportScope = "current",
): Promise<ProjectExportDownloadResult> {
  const prepared = await prepareProjectExport(projectName, scope);
  triggerPreparedProjectDownload(projectName, prepared);
  return prepared;
}
