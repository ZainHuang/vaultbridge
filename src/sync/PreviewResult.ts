import { PreviewError } from '../errors';
import type { DeviceState } from '../state/DeviceState';
import type { InitializationGateResult } from './InitializationGate';
import type { SyncPlan } from './SyncPlanner';

export interface PreviewResult {
  deviceState: DeviceState;
  gate: InitializationGateResult;
  plan: SyncPlan;
  /** Initialization/conflict eligibility only. Not authorization to write in Phase 1.5. */
  executionAllowed: boolean;
}

/** Future executors must call this before any write, in addition to their own guards. */
export function assertInitializationAllowsExecution(preview: PreviewResult): void {
  if (!preview.executionAllowed || preview.gate.status !== 'ALLOW' || preview.deviceState.initializationState === 'UNINITIALIZED') {
    throw new PreviewError('INITIALIZATION', 'SYNC_BLOCKED_BY_INITIALIZATION_GATE', 'Sync is blocked by the device initialization gate.');
  }
  if (preview.plan.hasConflicts) throw new PreviewError('PLAN', 'CONFLICT', 'Conflicts must be resolved before execution.');
}

export function declarationFingerprint(preview: PreviewResult): string {
  const { plan, deviceState } = preview;
  return JSON.stringify({ target: plan.target, head: plan.remoteHeadSha, tree: plan.remoteTreeSha,
    entries: plan.entries, localCount: plan.localCount, remoteCount: plan.remoteCount,
    deviceId: deviceState.deviceId, state: deviceState.initializationState,
    baseline: deviceState.lastVerifiedLocalFileCount });
}
