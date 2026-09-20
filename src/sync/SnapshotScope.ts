import type { RemoteSnapshot } from '../github/types';
import type { IgnoreService } from '../vault/IgnoreService';
import type { LocalSnapshot } from '../vault/VaultScanner';

/** One eligibility definition shared by Gate and planner summary counts. */
export function snapshotScope(local: LocalSnapshot, remote: RemoteSnapshot, ignore: IgnoreService) {
  const ignored = new Set(local.ignored.map(file => file.path));
  const eligible = (path: string) => !ignored.has(path) && !ignore.reason(path);
  const localFiles = local.files.filter(file => eligible(file.path));
  const remoteFiles = remote.entries.filter(file => file.type !== 'tree' && eligible(file.path));
  const localPaths = new Set(localFiles.map(file => file.path));
  return {
    localFiles,
    remoteFiles,
    // Includes rename old paths. Conflicted paths are conservatively included here;
    // the planner still owns path conflict detection and emits no writes for them.
    remoteOnlyCount: remoteFiles.filter(file => !localPaths.has(file.path)).length,
  };
}
