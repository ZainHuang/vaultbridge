import { IgnoreService } from '../../vault/IgnoreService';
import { gitBlobSha } from '../../vault/HashService';
import { assertPath, pathOrder, portableKey, portablePathIssue } from '../../vault/paths';
import type { SyncVault } from './SyncVault';
import type { SyncTransaction, TransactionStore } from './TransactionStore';

/** Files are the sync protocol. Folders are only pruned when a recorded former
 * file path establishes ownership, and the physical directory is truly empty. */
export async function cleanupEmptyFolders(vault: SyncVault, store: TransactionStore, t: SyncTransaction, ignore: IgnoreService): Promise<void> {
  const candidates = new Set<string>();
  const protectedPaths = [...Object.keys(t.after), ...t.excludedPaths].map(portableKey);
  for (const source of [t, ...await store.completedFolderSources(t)]) {
    const oldPaths = new Set([
      ...Object.keys(source.before),
      ...Object.values(source.originalState.baseManifest?.files ?? {}).map(f => f.path),
      ...Object.values(source.originalState.localFiles ?? {}).map(f => f.path),
      ...Object.values(source.manifest.files).filter(f => f.deleted).map(f => f.path),
    ]);
    for (const path of oldPaths) {
      assertPath(path);
      if (source.after[path] || t.after[path] || portablePathIssue(path) || ignore.reason(path)
        || source.excludedPaths.includes(path) || t.excludedPaths.includes(path)) continue;
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/'); const key = portableKey(parent);
        if (parts.slice(0, i).some(part => part.startsWith('.')) || ignore.reason(parent, true)
          || protectedPaths.some(p => p === key || p.startsWith(`${key}/`))) continue;
        candidates.add(parent);
      }
    }
  }
  // Remove children first. Unrelated empty subfolders are retained, not traversed.
  for (const path of [...candidates].sort((a, b) => b.split('/').length - a.split('/').length || pathOrder(a, b))) {
    const recovery = `${store.directory(t.id)}/empty-folders/${gitBlobSha(new TextEncoder().encode(path))}`;
    await vault.removeEmptyFolder(path, recovery);
  }
}
