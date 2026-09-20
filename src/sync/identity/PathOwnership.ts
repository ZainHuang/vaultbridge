import type { SyncDecision } from '../planner/SyncDecision';
/** An operation may not consume another logical file's current or destination path. */
export function blockPathOwnershipCollisions(entries: SyncDecision[], active: (entry: SyncDecision) => boolean): void {
  const ownership = new Map<string, SyncDecision[]>();
  for (const entry of entries) {
    if (!active(entry)) continue;
    for (const path of new Set([entry.path, ...(entry.oldPath ? [entry.oldPath] : [])])) {
      ownership.set(path, [...(ownership.get(path) ?? []), entry]);
    }
  }
  for (const owners of ownership.values()) if (owners.length > 1) {
    for (const entry of owners) {
      entry.category = 'CONFLICT_IDENTITY_UNCERTAIN';
      entry.reason = 'Multiple logical files share a current or destination path. Review identity ownership before any operation.';
    }
  }
}
