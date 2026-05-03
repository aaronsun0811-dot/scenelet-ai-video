/** 风格模版前端清单（id + category + thumbnail，prompt 由后端展开）。 */
import type { ContentTypeId } from "@/data/content-types";

export type StyleCategory = "content" | "live" | "anim";

export interface StyleTemplate {
  id: string;
  category: StyleCategory;
  thumbnail: string;  // 静态资源 URL（public/style-thumbnails/）
}

const THUMBNAIL_VERSION = "20260502-real-live-comic";

function styleThumbnail(id: string): string {
  return `/style-thumbnails/${id}.png?v=${THUMBNAIL_VERSION}`;
}

export const STYLE_TEMPLATES: StyleTemplate[] = [
  // ===== 内容类型定向 =====
  { id: "content_scene_sketch",       category: "content", thumbnail: styleThumbnail("content_scene_sketch") },
  { id: "content_short_drama",        category: "content", thumbnail: styleThumbnail("content_short_drama") },
  { id: "content_fiction_adaptation", category: "content", thumbnail: styleThumbnail("content_fiction_adaptation") },
  { id: "content_narration_story",    category: "content", thumbnail: styleThumbnail("content_narration_story") },
  { id: "content_ad_story",           category: "content", thumbnail: styleThumbnail("content_ad_story") },
  { id: "content_education_sketch",   category: "content", thumbnail: styleThumbnail("content_education_sketch") },
  { id: "content_travel_video",       category: "content", thumbnail: styleThumbnail("content_travel_video") },
  // ===== 真人 (18) =====
  { id: "live_cinematic_ancient", category: "live", thumbnail: styleThumbnail("live_cinematic_ancient") },
  { id: "live_zhang_yimou",       category: "live", thumbnail: styleThumbnail("live_zhang_yimou") },
  { id: "live_ancient_xianxia",   category: "live", thumbnail: styleThumbnail("live_ancient_xianxia") },
  { id: "live_premium_drama",     category: "live", thumbnail: styleThumbnail("live_premium_drama") },
  { id: "live_cinema",            category: "live", thumbnail: styleThumbnail("live_cinema") },
  { id: "live_spartan",           category: "live", thumbnail: styleThumbnail("live_spartan") },
  { id: "live_bladerunner",       category: "live", thumbnail: styleThumbnail("live_bladerunner") },
  { id: "live_got",               category: "live", thumbnail: styleThumbnail("live_got") },
  { id: "live_breaking_bad",      category: "live", thumbnail: styleThumbnail("live_breaking_bad") },
  { id: "live_kdrama",            category: "live", thumbnail: styleThumbnail("live_kdrama") },
  { id: "live_kurosawa",          category: "live", thumbnail: styleThumbnail("live_kurosawa") },
  { id: "live_nolan",             category: "live", thumbnail: styleThumbnail("live_nolan") },
  { id: "live_tarantino",         category: "live", thumbnail: styleThumbnail("live_tarantino") },
  { id: "live_lynch",             category: "live", thumbnail: styleThumbnail("live_lynch") },
  { id: "live_anderson",          category: "live", thumbnail: styleThumbnail("live_anderson") },
  { id: "live_wong",              category: "live", thumbnail: styleThumbnail("live_wong") },
  { id: "live_shaw",              category: "live", thumbnail: styleThumbnail("live_shaw") },
  { id: "live_cyberpunk",         category: "live", thumbnail: styleThumbnail("live_cyberpunk") },
  // ===== 动画 (18) =====
  { id: "anim_3d_cg",             category: "anim", thumbnail: styleThumbnail("anim_3d_cg") },
  { id: "anim_cn_3d",             category: "anim", thumbnail: styleThumbnail("anim_cn_3d") },
  { id: "anim_kyoto",             category: "anim", thumbnail: styleThumbnail("anim_kyoto") },
  { id: "anim_arcane",            category: "anim", thumbnail: styleThumbnail("anim_arcane") },
  { id: "anim_us_3d",             category: "anim", thumbnail: styleThumbnail("anim_us_3d") },
  { id: "anim_ink_wushan",        category: "anim", thumbnail: styleThumbnail("anim_ink_wushan") },
  { id: "anim_ink_papercut",      category: "anim", thumbnail: styleThumbnail("anim_ink_papercut") },
  { id: "anim_felt",              category: "anim", thumbnail: styleThumbnail("anim_felt") },
  { id: "anim_clay",              category: "anim", thumbnail: styleThumbnail("anim_clay") },
  { id: "anim_jp_horror",         category: "anim", thumbnail: styleThumbnail("anim_jp_horror") },
  { id: "anim_kr_webtoon",        category: "anim", thumbnail: styleThumbnail("anim_kr_webtoon") },
  { id: "anim_zzz",               category: "anim", thumbnail: styleThumbnail("anim_zzz") },
  { id: "anim_ghibli",            category: "anim", thumbnail: styleThumbnail("anim_ghibli") },
  { id: "anim_demon_slayer",      category: "anim", thumbnail: styleThumbnail("anim_demon_slayer") },
  { id: "anim_cyberpunk",         category: "anim", thumbnail: styleThumbnail("anim_cyberpunk") },
  { id: "anim_bloodborne",        category: "anim", thumbnail: styleThumbnail("anim_bloodborne") },
  { id: "anim_itojunji",          category: "anim", thumbnail: styleThumbnail("anim_itojunji") },
  { id: "anim_90s_retro",         category: "anim", thumbnail: styleThumbnail("anim_90s_retro") },
];

export const DEFAULT_TEMPLATE_ID = "content_scene_sketch";

export const DEFAULT_TEMPLATE_BY_CONTENT_TYPE: Record<ContentTypeId, string> = {
  scene_sketch: "content_scene_sketch",
  short_drama: "content_short_drama",
  fiction_adaptation: "content_fiction_adaptation",
  narration_story: "content_narration_story",
  ad_story: "content_ad_story",
  education_sketch: "content_education_sketch",
  travel_video: "content_travel_video",
};

export function getTemplatesByCategory(cat: StyleCategory): StyleTemplate[] {
  return STYLE_TEMPLATES.filter((t) => t.category === cat);
}

export function getTemplateById(id: string | null | undefined): StyleTemplate | undefined {
  return id ? STYLE_TEMPLATES.find((t) => t.id === id) : undefined;
}

export function getDefaultTemplateForContentType(contentType: ContentTypeId): string {
  return DEFAULT_TEMPLATE_BY_CONTENT_TYPE[contentType] ?? DEFAULT_TEMPLATE_ID;
}
