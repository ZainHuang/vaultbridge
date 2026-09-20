import type { LocalFile } from '../../vault/VaultScanner';
import { pathOrder } from '../../vault/paths';
import type { SyncManifest } from '../manifest/ManifestSchema';
import type { LocalFileState } from '../state/LocalSyncState';
import { renamedPath } from './SyncDomain';
export interface RenameEvent { oldPath: string; path: string }

/** Associates current bytes without generating IDs or mutating the recorded BASE. */
export function identifyLocal(files: LocalFile[], base: SyncManifest | null, remote: SyncManifest | null,
  localFiles: Record<string, LocalFileState> = {}, events: RenameEvent[] = []) {
  const remaining = new Map(files.map(file => [file.path, file]));
  const matched = new Map<string, LocalFileState>();
  const uncertainIds = new Set<string>();
  const ids = [...new Set([...Object.keys(base?.files ?? {}), ...Object.keys(remote?.files ?? {}), ...Object.keys(localFiles)])].sort(pathOrder);
  const claim = (id: string, path: string) => {
    const file = remaining.get(path);
    if (!file) return false;
    matched.set(id, { fileId: id, path, blobSha: file.sha, deleted: false });
    remaining.delete(path);
    return true;
  };
  // Stable local identity is strongest. Events are applied in their observed order.
  for (const id of ids) {
    const recorded = localFiles[id];
    if (recorded?.deleted && remaining.has(recorded.path)
      && !Object.values(localFiles).some(other => other.fileId !== id && !other.deleted && other.path === recorded.path)) uncertainIds.add(id);
    if (recorded && !recorded.deleted && claim(id, recorded.path)) continue;
    let path = recorded?.path ?? base?.files[id]?.path;
    if (!path) continue;
    let renamed = false;
    for (const event of events) { const next = renamedPath(path, event); if (next !== path) { path = next; renamed = true; } }
    if (renamed) claim(id, path);
  }
  // Reserve known unchanged paths before considering any content heuristic.
  for (const id of ids) {
    if (matched.has(id)) continue;
    const entry = base?.files[id] ?? remote?.files[id];
    if (entry && !entry.deleted) claim(id, entry.path);
  }
  const missing = ids.filter(id => base?.files[id] && !base.files[id]!.deleted && !matched.has(id));
  for (const id of missing) {
    if (localFiles[id]?.deleted) continue;
    const entry = base!.files[id]!;
    const candidates = [...remaining.values()].filter(file => file.sha === entry.blobSha);
    const sameHashMissing = missing.filter(other => base!.files[other]!.blobSha === entry.blobSha);
    if (candidates.length === 1 && sameHashMissing.length === 1) claim(id, candidates[0]!.path);
  }
  // Missing identity plus unexplained new paths might be rename+edit. Never guess delete+add.
  const unexplained = missing.filter(id => !matched.has(id) && !localFiles[id]?.deleted);
  if (remaining.size && unexplained.length) unexplained.forEach(id => uncertainIds.add(id));
  const uncertainPaths = new Set(uncertainIds.size ? remaining.keys() : []);
  // A tombstone path without an independently live identity is not a fresh addition.
  for (const id of ids) {
    const entry = base?.files[id] ?? remote?.files[id];
    if (entry?.deleted && !matched.has(id)) claim(id, entry.path);
  }
  return { matched, remaining, uncertainIds, uncertainPaths };
}
