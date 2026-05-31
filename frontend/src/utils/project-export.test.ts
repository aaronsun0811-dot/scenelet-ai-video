import { describe, expect, it } from "vitest";
import type { ProjectArchiveDeliveryReport } from "@/types";
import {
  countProjectExportPreflightIssues,
  firstDeliveryReportIssueEpisode,
  getDeliveryReportDownloadBaseName,
  hasTravelRouteAssetManifest,
  renderDeliveryReportMarkdown,
  serializeDeliveryReportJson,
  shouldShowProjectExportPreflightDialog,
} from "./project-export";

function makeReport(
  overrides: Partial<ProjectArchiveDeliveryReport> = {},
): ProjectArchiveDeliveryReport {
  return {
    format_version: 1,
    status: "needs_work",
    generated_at: "2026-05-02T00:00:00+08:00",
    totals: {
      episodes: 2,
      ready_episodes: 1,
      scripts_ready: 2,
      storyboards_ready: 1,
      storyboards_total: 2,
      videos_ready: 1,
      videos_total: 2,
      blocking_issues: 1,
      warnings: 1,
    },
    episodes: [
      {
        episode: 1,
        title: "EP1",
        script_file: "scripts/episode_1.json",
        script_ready: true,
        status: "ready",
        storyboards: { ready: 1, total: 1, missing: [] },
        videos: { ready: 1, total: 1, missing: [] },
        blocking_issues: [],
        warnings: [],
      },
      {
        episode: 2,
        title: "EP2",
        script_file: "scripts/episode_2.json",
        script_ready: true,
        status: "needs_work",
        storyboards: { ready: 0, total: 1, missing: ["E2S01"] },
        videos: { ready: 0, total: 1, missing: ["E2S01"] },
        blocking_issues: [
          { code: "missing_videos", message: "1 个视频未生成", items: ["E2S01"] },
        ],
        warnings: [],
      },
    ],
    ...overrides,
  };
}

describe("project export helpers", () => {
  it("counts only blocking/warning preflight issues before download", () => {
    expect(
      countProjectExportPreflightIssues({
        diagnostics: {
          blocking: [{ code: "broken", message: "阻断" }],
          auto_fixed: [{ code: "fixed", message: "已修复" }],
          warnings: [{ code: "warn", message: "提醒" }],
        },
        deliveryReport: makeReport(),
        travelRouteAssets: null,
        modelRuleAudit: null,
      }),
    ).toBe(4);
  });

  it("finds the first delivery report episode that needs attention", () => {
    expect(firstDeliveryReportIssueEpisode(makeReport())).toBe(2);
    expect(firstDeliveryReportIssueEpisode(makeReport({ episodes: [] }))).toBeNull();
    expect(firstDeliveryReportIssueEpisode(null)).toBeNull();
  });

  it("serializes delivery reports for JSON and Markdown downloads", () => {
    const report = makeReport();

    expect(JSON.parse(serializeDeliveryReportJson(report))).toMatchObject({
      status: "needs_work",
      totals: { blocking_issues: 1 },
    });
    expect(renderDeliveryReportMarkdown(report)).toContain("# Scenelet 交付检查报告");
    expect(renderDeliveryReportMarkdown(report)).toContain("- 阻断: 1 个视频未生成 (E2S01)");
  });

  it("renders travel route delivery details", () => {
    const markdown = renderDeliveryReportMarkdown(makeReport({
      travel_route: {
        route_ready: true,
        source: "reference_images",
        origin: "难波站",
        destination: "黑门市场",
        summary: "沿千日前通步行到黑门市场。",
        distance_text: "1.2 km",
        duration_text: "15 mins",
        nodes_total: 2,
        nodes_covered: 1,
        reference_images_count: 3,
        usable_reference_images_count: 2,
        nodes: [
          {
            id: "node-1",
            label: "千日前通",
            covered: true,
            matched_units: ["E1U1"],
          },
          {
            id: "node-2",
            label: "黑门市场",
            covered: false,
            matched_units: [],
          },
        ],
      },
    }));

    expect(markdown).toContain("## 旅游路线检查");
    expect(markdown).toContain("- 路线摘要: 沿千日前通步行到黑门市场。");
    expect(markdown).toContain("- 路线节点覆盖: 1 / 2");
    expect(markdown).toContain("- 参考图数量: 2 / 3 可用");
    expect(markdown).toContain("- 未覆盖节点: 黑门市场");
  });

  it("renders model rule audit details in delivery report markdown", () => {
    const markdown = renderDeliveryReportMarkdown(makeReport({
      model_rule_audit: {
        total: 2,
        by_mode: { github_skill: 1, prompt: 1 },
        by_media_type: { video: 1, image: 1 },
        artifact_files: [
          "output/scenelet-model-rule-audit.json",
          "output/scenelet-model-rule-audit.md",
        ],
      },
    }));

    expect(markdown).toContain("## 模型规则审计");
    expect(markdown).toContain("- 记录任务: 2");
    expect(markdown).toContain("GitHub Skill 1");
    expect(markdown).toContain("Prompt 1");
    expect(markdown).toContain("output/scenelet-model-rule-audit.md");
  });

  it("opens the preflight dialog for clean travel exports so the route checklist is visible", () => {
    const cleanTravelReport = makeReport({
      status: "ready",
      totals: {
        episodes: 1,
        ready_episodes: 1,
        scripts_ready: 1,
        storyboards_ready: 0,
        storyboards_total: 0,
        videos_ready: 1,
        videos_total: 1,
        blocking_issues: 0,
        warnings: 0,
      },
      episodes: [],
      travel_route: {
        route_ready: true,
        source: "reference_images",
        origin: "难波站",
        destination: "黑门市场",
        summary: "沿千日前通步行到黑门市场。",
        nodes_total: 1,
        nodes_covered: 1,
        reference_images_count: 1,
        usable_reference_images_count: 1,
        nodes: [],
      },
    });
    const result = {
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      deliveryReport: cleanTravelReport,
      travelRouteAssets: null,
      modelRuleAudit: null,
    };

    expect(countProjectExportPreflightIssues(result)).toBe(0);
    expect(hasTravelRouteAssetManifest(result)).toBe(true);
    expect(shouldShowProjectExportPreflightDialog(result)).toBe(true);
    expect(shouldShowProjectExportPreflightDialog({
      diagnostics: { blocking: [], auto_fixed: [], warnings: [] },
      deliveryReport: makeReport({ status: "ready", episodes: [], totals: cleanTravelReport.totals }),
      travelRouteAssets: null,
      modelRuleAudit: null,
    })).toBe(false);
  });

  it("adds the delivery report generation time to download filenames", () => {
    const reportWithoutTime = makeReport();
    delete reportWithoutTime.generated_at;

    expect(getDeliveryReportDownloadBaseName(makeReport())).toBe(
      "scenelet-delivery-report-20260502-000000",
    );
    expect(getDeliveryReportDownloadBaseName(makeReport(), "我的 项目/01")).toBe(
      "scenelet-delivery-report-我的-项目-01-20260502-000000",
    );
    expect(getDeliveryReportDownloadBaseName(makeReport({ generated_at: "手动检查" }))).toBe(
      "scenelet-delivery-report-generated",
    );
    expect(getDeliveryReportDownloadBaseName(reportWithoutTime)).toBe("scenelet-delivery-report");
  });
});
