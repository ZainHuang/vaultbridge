import type { RemoteEntry } from '../../github/types';
import type { SyncManifest, ManifestFileEntry } from './ManifestSchema';
import { invalidManifest } from './ManifestValidator';
import type { ManifestIssue } from './ManifestDiagnostics';

function sameVersion(a: ManifestFileEntry, b: ManifestFileEntry): boolean {
  return a.path === b.path && a.blobSha === b.blobSha && a.deleted === b.deleted;
}
export function validateManifestHistory(base: SyncManifest | null, remote: SyncManifest): void {
  if (!base) return;
  const issues: ManifestIssue[] = [];
  if (remote.generation < base.generation) issues.push({ kind: 'HISTORY_LINEAGE_MISMATCH', expected: base.generation, actual: remote.generation, detail: 'Generation rollback' });
  for (const entry of Object.values(base.files)) {
    const current = remote.files[entry.fileId];
    if (!current) { issues.push({ kind: 'HISTORY_LINEAGE_MISMATCH', fileId: entry.fileId, path: entry.path, detail: 'Stable identity disappeared' }); continue; }
    if (entry.deleted && !current.deleted) issues.push({ kind: 'INVALID_ENTRY_STATE', fileId: entry.fileId, path: entry.path, detail: 'Tombstone identity resurrected' });
    if (current.revision < entry.revision || !sameVersion(entry, current) && (current.revision <= entry.revision || remote.generation <= base.generation)
      || remote.generation === base.generation && current.revision !== entry.revision) {
      issues.push({ kind: 'HISTORY_LINEAGE_MISMATCH', fileId: entry.fileId, path: current.path, expected: entry.revision, actual: current.revision,
        detail: `Revision transition at generation ${base.generation} -> ${remote.generation}` });
    }
  }
  if (remote.generation === base.generation && Object.keys(base.files).length !== Object.keys(remote.files).length) issues.push({ kind: 'HISTORY_LINEAGE_MISMATCH', detail: 'Identity set changed without a generation increment' });
  if (issues.length) throw invalidManifest(issues);
}
export function validateManifestTree(remote: SyncManifest, files: RemoteEntry[], eligible: (path: string) => boolean): void {
  const live = new Map(Object.values(remote.files).filter(entry => !entry.deleted && eligible(entry.path)).map(entry => [entry.path, entry]));
  const issues: ManifestIssue[] = [];
  const tree = new Map(files.map(file => [file.path, file]));
  if (tree.size !== files.length) issues.push({ kind: 'DUPLICATE_LIVE_PATH', detail: 'Duplicate Tree path' });
  for (const entry of live.values()) if (!tree.has(entry.path)) issues.push({ kind: 'LIVE_PATH_MISSING', path: entry.path, fileId: entry.fileId, expectedSha: entry.blobSha!, actualSha: null });
  for (const file of files) {
    if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) issues.push({ kind: 'UNSUPPORTED_TREE_ENTRY', path: file.path, detail: `${file.type} ${file.mode}` });
    const entry = live.get(file.path);
    if (!entry || entry.blobSha !== file.sha) issues.push({ kind: entry ? 'BLOB_SHA_MISMATCH' : 'UNTRACKED_ELIGIBLE_PATH', path: file.path, fileId: entry?.fileId, expectedSha: entry?.blobSha ?? null, actualSha: file.sha });
  }
  if (issues.length) throw invalidManifest(issues);
}
