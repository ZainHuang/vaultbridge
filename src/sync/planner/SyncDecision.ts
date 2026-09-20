export const DECISIONS = [
  'PUSH_ADD', 'PUSH_UPDATE', 'PUSH_DELETE', 'PUSH_RENAME', 'PUSH_RENAME_AND_UPDATE',
  'PULL_ADD', 'PULL_UPDATE', 'PULL_DELETE', 'PULL_RENAME', 'PULL_RENAME_AND_UPDATE',
  'UNCHANGED', 'ALREADY_CONVERGED', 'CONFLICT_CONTENT', 'CONFLICT_DELETE_MODIFY',
  'CONFLICT_ADD_ADD', 'CONFLICT_RENAME_RENAME', 'CONFLICT_IDENTITY_UNCERTAIN',
] as const;
export type DecisionCategory = typeof DECISIONS[number];
export interface SyncDecision {
  category: DecisionCategory;
  path: string;
  oldPath?: string;
  fileId?: string;
  baseSha?: string;
  localSha?: string;
  remoteSha?: string;
  reason?: string;
}
export type PlanStatus = 'READY' | 'BOOTSTRAP_FROM_REMOTE' | 'BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY'
  | 'INITIALIZE_REMOTE_FROM_LOCAL' | 'LEGACY_REMOTE_REQUIRES_ADOPTION' | 'REMOTE_MANIFEST_INVALID'
  | 'REMOTE_MANIFEST_MISSING' | 'LOCAL_STATE_INVALID';
export interface ThreeWayPlan {
  status: PlanStatus;
  reason?: string;
  deviceState: 'NEW DEVICE' | 'SYNC HISTORY PRESENT';
  remoteGeneration?: number;
  remoteHeadSha: string;
  localCount: number;
  remoteCount: number;
  entries: SyncDecision[];
  counts: Record<DecisionCategory, number>;
  hasConflicts: boolean;
  /** This phase exposes no executor, including for READY plans. */
  executionAllowed: false;
}
