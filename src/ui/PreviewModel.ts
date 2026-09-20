import type { DecisionCategory, ThreeWayPlan } from '../sync/planner/SyncDecision';
import type { SyncPreview } from '../sync/execution/SyncService';
export function canExecutePreview(preview: Pick<SyncPreview, 'canExecute' | 'mode' | 'plan'>): boolean {
  return preview.canExecute && preview.mode !== 'BLOCKED' && ['READY', 'INITIALIZE_REMOTE_FROM_LOCAL', 'BOOTSTRAP_FROM_REMOTE',
    'LEGACY_REMOTE_REQUIRES_ADOPTION', 'BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY'].includes(preview.plan.status);
}
export const PREVIEW_GROUPS = ['Push', 'Pull', 'Conflict', 'Bootstrap', 'Unchanged'] as const;
export type PreviewGroup = typeof PREVIEW_GROUPS[number];
export function decisionGroup(category: DecisionCategory): PreviewGroup {
  if (category.startsWith('PUSH_')) return 'Push';
  if (category.startsWith('PULL_')) return 'Pull';
  if (category.startsWith('CONFLICT_')) return 'Conflict';
  return 'Unchanged';
}
export function previewGroups(plan: ThreeWayPlan): Record<PreviewGroup, number> {
  const groups = { Push: 0, Pull: 0, Conflict: 0, Bootstrap: 0, Unchanged: 0 };
  plan.entries.forEach(entry => groups[decisionGroup(entry.category)]++);
  if (plan.status === 'BOOTSTRAP_FROM_REMOTE' || plan.status === 'INITIALIZE_REMOTE_FROM_LOCAL') groups.Bootstrap++;
  return groups;
}
