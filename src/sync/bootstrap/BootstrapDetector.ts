import type { SyncManifest } from '../manifest/ManifestSchema';
import type { PlanStatus } from '../planner/SyncDecision';
export function detectBootstrap(base: SyncManifest | null, remoteManifest: SyncManifest | null, localCount: number, remoteCount: number): { status: PlanStatus; reason?: string } {
  if (!remoteManifest) {
    if (base) return { status: 'REMOTE_MANIFEST_MISSING', reason: 'This device has sync history, but the remote manifest is missing. Sync is blocked.' };
    if (remoteCount) return { status: 'LEGACY_REMOTE_REQUIRES_ADOPTION', reason: 'Existing repository has no sync manifest. A one-time adoption/migration is required.' };
    return { status: 'INITIALIZE_REMOTE_FROM_LOCAL', reason: 'Empty remote user domain. Remote initialization can be planned; execution is unavailable.' };
  }
  if (!base) return localCount
    ? { status: 'BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY', reason: 'This device has no sync history but the local Vault is not empty.' }
    : { status: 'BOOTSTRAP_FROM_REMOTE', reason: 'BOOTSTRAP FROM GITHUB. This device has no synchronized base. Preview only; no files are downloaded.' };
  return { status: 'READY' };
}
