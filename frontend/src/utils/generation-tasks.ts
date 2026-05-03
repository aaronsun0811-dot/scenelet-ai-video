import type { TaskItem, TaskStatus } from "@/types";
import { normalizeScriptFileKey } from "./script-generation";

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);

export function isActiveGenerationTask(task: TaskItem): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

export function getActiveGenerationResourceIds(
  tasks: TaskItem[],
  projectName: string | null | undefined,
  taskType: string,
  scriptFile?: string | null,
): Set<string> {
  const normalizedScriptFile = normalizeScriptFileKey(scriptFile);
  const resourceIds = new Set<string>();

  for (const task of tasks) {
    if (task.project_name !== projectName) continue;
    if (task.task_type !== taskType) continue;
    if (!isActiveGenerationTask(task)) continue;
    if (normalizedScriptFile) {
      const taskScriptFile = normalizeScriptFileKey(task.script_file);
      if (taskScriptFile && taskScriptFile !== normalizedScriptFile) continue;
    }
    resourceIds.add(task.resource_id);
  }

  return resourceIds;
}
