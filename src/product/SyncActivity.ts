import type { ProductCache } from './ProductStore';

export type ActivityStage = 'Scan local' | 'Read remote' | 'Build plan' | 'Revalidate' | 'Stage recovery copies' | 'Backup remote' | 'Upload blobs' | 'Create tree' | 'Create commit' | 'Check candidate' | 'Publish' | 'Verify remote' | 'Apply local' | 'Verify local' | 'Save BASE' | 'Finalize transaction' | 'Complete';
export interface ActivitySnapshot {
  running: boolean; operation?: 'preview' | 'sync'; stage?: ActivityStage;
  steps: { stage: ActivityStage; at: number }[];
  startedAt?: number; endedAt?: number; transactionId?: string; generation?: number;
  processed?: number; total?: number; error?: string; verified: boolean; review?: boolean;
}
export type ActivityEvent =
  | { type: 'start'; operation: 'preview' | 'sync' }
  | { type: 'stage'; stage: ActivityStage; processed?: number; total?: number; transactionId?: string; generation?: number; completedSteps?: ActivitySnapshot['steps'] }
  | { type: 'end'; error?: string };

/** Pure presentation of existing ProductStore data. Never authorizes execution. */
export function activityIndicator(cache: ProductCache, activity: ActivitySnapshot, now = Date.now(), error?: string) {
  const result = (label: string, destination: 'activity' | 'preview' | 'recovery' = 'activity', animated = false) => ({ label, destination, animated });
  if (activity.running) return result(activity.operation === 'preview' ? 'Previewing'
    : ['Verify remote', 'Verify local', 'Save BASE', 'Finalize transaction'].includes(activity.stage ?? '') ? 'Verifying' : 'Syncing', 'activity', true);
  if (cache.status === 'Recovery Required') return result('Review required · Recovery required', 'recovery');
  if (cache.status === 'Conflict') return result('Review required · Conflict', 'preview');
  if (error || activity.error || cache.status === 'Offline' || cache.auto.result === 'Offline') return result('Error');
  if (cache.auto.result === 'Manual confirmation required' || activity.review) return result('Review required', 'preview');
  if (cache.auto.scheduledAt !== undefined) return result(`Auto sync in ${Math.max(0, Math.ceil((cache.auto.scheduledAt - now) / 1000))}s`);
  if (cache.status === 'Healthy' && activity.verified && activity.endedAt !== undefined && now - activity.endedAt < 4000) return result('Synced & verified');
  return result(cache.status === 'Healthy' ? 'Healthy' : cache.lastChangeAt ? 'Local changes' : 'Review required', cache.lastChangeAt || cache.status === 'Healthy' ? 'activity' : 'preview');
}
