import type { DeviceState } from '../state/DeviceState';
import type { RemoteSnapshot } from '../github/types';
import type { IgnoreService } from '../vault/IgnoreService';
import type { LocalSnapshot } from '../vault/VaultScanner';
import { snapshotScope } from './SnapshotScope';

export const NEAR_EMPTY_LOCAL_LIMIT = 5;
export const SIGNIFICANT_FILE_COUNT = 20;
export const FIRST_SYNC_DELETE_RATIO = 0.5;

export interface InitializationGateResult {
  status: 'ALLOW' | 'BLOCK_NEW_DEVICE' | 'BLOCK_SUSPICIOUS_EMPTY_LOCAL' | 'BLOCK_FIRST_SYNC_MASS_DELETE';
  reason: string;
  suggestedAction?: 'INITIALIZE_FROM_REMOTE' | 'DECLARE_LOCAL_PRIMARY';
}

/** Pure, read-only decision. Never updates initialization state or scans again. */
export class InitializationGate {
  evaluate(local: LocalSnapshot, remote: RemoteSnapshot, device: DeviceState, ignore: IgnoreService): InitializationGateResult {
    const scope = snapshotScope(local, remote, ignore);
    const localCount = scope.localFiles.length;
    const remoteCount = scope.remoteFiles.length;
    if (device.initializationState !== 'UNINITIALIZED') {
      if ((device.lastVerifiedLocalFileCount ?? 0) >= SIGNIFICANT_FILE_COUNT
        && localCount <= NEAR_EMPTY_LOCAL_LIMIT && remoteCount >= SIGNIFICANT_FILE_COUNT) {
        return { status: 'BLOCK_SUSPICIOUS_EMPTY_LOCAL', reason: 'Possible incomplete local Vault. A previously verified large Vault is now nearly empty. Check the Vault location and file availability before continuing.', suggestedAction: 'INITIALIZE_FROM_REMOTE' };
      }
      return { status: 'ALLOW', reason: 'This device has explicitly entered an initialized state.' };
    }
    if (localCount === 0 && remoteCount > 0) {
      return { status: 'BLOCK_NEW_DEVICE', reason: 'This looks like a new device. Your local Vault is empty, but GitHub contains existing files. Local → GitHub Mirror is blocked to prevent accidental deletion of the remote Vault.', suggestedAction: 'INITIALIZE_FROM_REMOTE' };
    }
    if (localCount <= NEAR_EMPTY_LOCAL_LIMIT && remoteCount >= SIGNIFICANT_FILE_COUNT) {
      return { status: 'BLOCK_NEW_DEVICE', reason: 'This looks like a new device. Your local Vault is nearly empty, but GitHub contains an existing Vault. Local → GitHub Mirror is blocked to prevent accidental deletion.', suggestedAction: 'INITIALIZE_FROM_REMOTE' };
    }
    if (scope.remoteOnlyCount > 0 && scope.remoteOnlyCount / remoteCount >= FIRST_SYNC_DELETE_RATIO) {
      return { status: 'BLOCK_FIRST_SYNC_MASS_DELETE', reason: `First synchronization would delete ${(100 * scope.remoteOnlyCount / remoteCount).toFixed(1)}% of the remote Vault. This device has never been initialized. Sync is blocked.`, suggestedAction: 'DECLARE_LOCAL_PRIMARY' };
    }
    // Explicit initialization is mandatory even below the danger thresholds or with
    // an empty remote. A successful diagnostic Preview must not silently grant authority.
    return { status: 'BLOCK_NEW_DEVICE', reason: 'This device has never been initialized. Review the current Vault and explicitly declare Local Primary, or initialize from GitHub when Restore is available.', suggestedAction: 'DECLARE_LOCAL_PRIMARY' };
  }
}
