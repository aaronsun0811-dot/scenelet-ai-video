import type { GenerationMode } from "@/utils/generation-mode";

export const CONTENT_TYPE_IDS = [
  "scene_sketch",
  "short_drama",
  "fiction_adaptation",
  "narration_story",
  "ad_story",
  "education_sketch",
  "travel_video",
] as const;

export type ContentTypeId = (typeof CONTENT_TYPE_IDS)[number];

export interface ContentTypePreset {
  id: ContentTypeId;
  labelKey: string;
  descriptionKey: string;
  workflowGoalKey: string;
  workflowRuleKeys: readonly string[];
  contentMode: "narration" | "drama";
  aspectRatio: "9:16" | "16:9";
  generationMode: GenerationMode;
  defaultDuration: number;
  defaultStyleTemplateId: `content_${string}`;
}

export const CONTENT_TYPE_PRESETS: ContentTypePreset[] = [
  {
    id: "scene_sketch",
    labelKey: "dashboard:content_type_scene_sketch",
    descriptionKey: "dashboard:content_type_scene_sketch_desc",
    workflowGoalKey: "dashboard:content_workflow_scene_sketch_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_scene_sketch_rule_1",
      "dashboard:content_workflow_scene_sketch_rule_2",
      "dashboard:content_workflow_scene_sketch_rule_3",
    ],
    contentMode: "drama",
    aspectRatio: "16:9",
    generationMode: "storyboard",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_scene_sketch",
  },
  {
    id: "short_drama",
    labelKey: "dashboard:content_type_short_drama",
    descriptionKey: "dashboard:content_type_short_drama_desc",
    workflowGoalKey: "dashboard:content_workflow_short_drama_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_short_drama_rule_1",
      "dashboard:content_workflow_short_drama_rule_2",
      "dashboard:content_workflow_short_drama_rule_3",
    ],
    contentMode: "drama",
    aspectRatio: "9:16",
    generationMode: "storyboard",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_short_drama",
  },
  {
    id: "fiction_adaptation",
    labelKey: "dashboard:content_type_fiction_adaptation",
    descriptionKey: "dashboard:content_type_fiction_adaptation_desc",
    workflowGoalKey: "dashboard:content_workflow_fiction_adaptation_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_fiction_adaptation_rule_1",
      "dashboard:content_workflow_fiction_adaptation_rule_2",
      "dashboard:content_workflow_fiction_adaptation_rule_3",
    ],
    contentMode: "drama",
    aspectRatio: "9:16",
    generationMode: "storyboard",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_fiction_adaptation",
  },
  {
    id: "narration_story",
    labelKey: "dashboard:content_type_narration_story",
    descriptionKey: "dashboard:content_type_narration_story_desc",
    workflowGoalKey: "dashboard:content_workflow_narration_story_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_narration_story_rule_1",
      "dashboard:content_workflow_narration_story_rule_2",
      "dashboard:content_workflow_narration_story_rule_3",
    ],
    contentMode: "narration",
    aspectRatio: "9:16",
    generationMode: "storyboard",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_narration_story",
  },
  {
    id: "ad_story",
    labelKey: "dashboard:content_type_ad_story",
    descriptionKey: "dashboard:content_type_ad_story_desc",
    workflowGoalKey: "dashboard:content_workflow_ad_story_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_ad_story_rule_1",
      "dashboard:content_workflow_ad_story_rule_2",
      "dashboard:content_workflow_ad_story_rule_3",
    ],
    contentMode: "drama",
    aspectRatio: "9:16",
    generationMode: "reference_video",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_ad_story",
  },
  {
    id: "education_sketch",
    labelKey: "dashboard:content_type_education_sketch",
    descriptionKey: "dashboard:content_type_education_sketch_desc",
    workflowGoalKey: "dashboard:content_workflow_education_sketch_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_education_sketch_rule_1",
      "dashboard:content_workflow_education_sketch_rule_2",
      "dashboard:content_workflow_education_sketch_rule_3",
    ],
    contentMode: "narration",
    aspectRatio: "16:9",
    generationMode: "storyboard",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_education_sketch",
  },
  {
    id: "travel_video",
    labelKey: "dashboard:content_type_travel_video",
    descriptionKey: "dashboard:content_type_travel_video_desc",
    workflowGoalKey: "dashboard:content_workflow_travel_video_goal",
    workflowRuleKeys: [
      "dashboard:content_workflow_travel_video_rule_1",
      "dashboard:content_workflow_travel_video_rule_2",
      "dashboard:content_workflow_travel_video_rule_3",
    ],
    contentMode: "narration",
    aspectRatio: "16:9",
    generationMode: "reference_video",
    defaultDuration: 8,
    defaultStyleTemplateId: "content_travel_video",
  },
];

export const DEFAULT_CONTENT_TYPE: ContentTypeId = "scene_sketch";

export function isContentTypeId(value: unknown): value is ContentTypeId {
  return typeof value === "string" && (CONTENT_TYPE_IDS as readonly string[]).includes(value);
}

export function getContentTypePreset(value: unknown): ContentTypePreset | null {
  if (!isContentTypeId(value)) return null;
  return CONTENT_TYPE_PRESETS.find((preset) => preset.id === value) ?? null;
}
