import type { LocalFileState } from '../state/LocalSyncState';
import type { SyncDecision, DecisionCategory } from './SyncDecision';
export interface FileResolutionInput {
  base?: LocalFileState;
  local?: LocalFileState;
  remote?: LocalFileState;
}
export function resolveFile({ base, local, remote }: FileResolutionInput): SyncDecision {
  const file = local ?? remote ?? base;
  if (!file) throw new Error('A logical file is required.');
  const decision = (category: DecisionCategory): SyncDecision => ({ category, fileId: file.fileId || undefined, path: file.path,
    baseSha: base?.blobSha, localSha: local?.blobSha, remoteSha: remote?.blobSha });
  if (base && [local, remote].some(side => side?.fileId && side.fileId !== base.fileId)) return decision('CONFLICT_IDENTITY_UNCERTAIN');
  if (!base) {
    if (remote?.deleted) return decision(local && !local.deleted ? 'CONFLICT_DELETE_MODIFY' : 'UNCHANGED');
    if (!local || local.deleted) return decision(remote ? 'PULL_ADD' : 'UNCHANGED');
    if (!remote) return decision('PUSH_ADD');
    if (local.path !== remote.path) return decision('CONFLICT_IDENTITY_UNCERTAIN');
    return decision(local.blobSha === remote.blobSha ? 'ALREADY_CONVERGED' : 'CONFLICT_ADD_ADD');
  }
  if (!remote) return decision('CONFLICT_IDENTITY_UNCERTAIN');
  const localDeleted = !local || local.deleted;
  if (base.deleted) return decision(localDeleted && remote.deleted ? 'UNCHANGED' : 'CONFLICT_DELETE_MODIFY');
  if (localDeleted && remote.deleted) return decision('ALREADY_CONVERGED');
  if (localDeleted) return decision(remote.blobSha === base.blobSha && remote.path === base.path ? 'PUSH_DELETE' : 'CONFLICT_DELETE_MODIFY');
  if (remote.deleted) return decision(local.blobSha === base.blobSha && local.path === base.path ? 'PULL_DELETE' : 'CONFLICT_DELETE_MODIFY');
  const localRenamed = local.path !== base.path;
  const remoteRenamed = remote.path !== base.path;
  if (localRenamed && remoteRenamed && local.path !== remote.path) return decision('CONFLICT_RENAME_RENAME');
  if (localRenamed !== remoteRenamed) {
    const opposite = localRenamed ? remote : local;
    if (opposite.blobSha !== base.blobSha) return decision('CONFLICT_CONTENT');
    const changed = localRenamed ? local : remote;
    const category = localRenamed
      ? changed.blobSha === base.blobSha ? 'PUSH_RENAME' : 'PUSH_RENAME_AND_UPDATE'
      : changed.blobSha === base.blobSha ? 'PULL_RENAME' : 'PULL_RENAME_AND_UPDATE';
    return { ...decision(category), oldPath: base.path, path: changed.path };
  }
  if (localRenamed && remoteRenamed && local.blobSha === remote.blobSha) return decision('ALREADY_CONVERGED');
  if (local.blobSha === base.blobSha && remote.blobSha === base.blobSha) return decision('UNCHANGED');
  if (local.blobSha === remote.blobSha) return decision('ALREADY_CONVERGED');
  if (remote.blobSha === base.blobSha) return decision('PUSH_UPDATE');
  if (local.blobSha === base.blobSha) return decision('PULL_UPDATE');
  return decision('CONFLICT_CONTENT');
}
