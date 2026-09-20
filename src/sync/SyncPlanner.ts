import { PreviewError } from '../errors';
import type { RemoteSnapshot, RepositoryTarget } from '../github/types';
import type { IgnoreService } from '../vault/IgnoreService';
import { pathOrder } from '../vault/paths';
import { pathConflictChecker } from '../vault/PathConflictDetector';
import type { LocalSnapshot } from '../vault/VaultScanner';
import { snapshotScope } from './SnapshotScope';

export const CATEGORIES = ['ADD', 'UPDATE', 'DELETE', 'RENAME', 'UNCHANGED', 'IGNORED', 'CONFLICT'] as const;
export type Category = typeof CATEGORIES[number];
export interface PlannedOperation { action: 'ADD_REMOTE' | 'UPDATE_REMOTE' | 'DELETE_REMOTE'; path: string; sha?: string }
export interface PlanEntry {
  category: Category;
  path: string;
  oldPath?: string;
  localSha?: string;
  remoteSha?: string;
  source?: 'local' | 'remote' | 'both';
  reason?: string;
  operations: PlannedOperation[];
}
export interface SyncPlan {
  target: RepositoryTarget;
  remoteHeadSha: string;
  remoteTreeSha: string;
  createdAt: string;
  localCount: number;
  remoteCount: number;
  counts: Record<Category, number>;
  operationCounts: Record<PlannedOperation['action'], number>;
  entries: PlanEntry[];
  protectedDirectories: string[];
  deleteSafetyThreshold: number;
  highRisk: boolean;
  hasConflicts: boolean;
}

export class SyncPlanner {
  create(local: LocalSnapshot, remote: RemoteSnapshot, ignore: IgnoreService, target: RepositoryTarget, threshold = 20): SyncPlan {
    if (new Set(local.files.map(file => file.path)).size !== local.files.length
      || new Set(remote.entries.map(file => file.path)).size !== remote.entries.length) {
      throw new PreviewError('PLAN', 'DUPLICATE_PATH', 'Snapshot contains duplicate paths.');
    }
    const localMap = new Map(local.files.map(file => [file.path, file]));
    const remoteMap = new Map(remote.entries.filter(file => file.type !== 'tree').map(file => [file.path, file]));
    const ignored = new Map(local.ignored.map(file => [file.path, file.reason]));
    const localIgnoredPaths = new Set(ignored.keys());
    const allPaths = [...new Set([...localMap.keys(), ...remoteMap.keys(), ...ignored.keys()])].sort(pathOrder);
    for (const path of allPaths) {
      const reason = ignore.reason(path);
      if (reason) ignored.set(path, reason);
    }
    const managed = allPaths.filter(path => !ignored.has(path));
    const checkConflict = pathConflictChecker(managed, remote.entries, ignore);
    const entries: PlanEntry[] = [];
    for (const path of allPaths) {
      const l = localMap.get(path);
      const r = remoteMap.get(path);
      const source: PlanEntry['source'] = (l || localIgnoredPaths.has(path)) ? r ? 'both' : 'local' : 'remote';
      if (ignored.has(path)) {
        entries.push({ category: 'IGNORED', path, source, reason: ignored.get(path), operations: [] });
        continue;
      }
      const conflict = checkConflict(path, r);
      const base = { path, localSha: l?.sha, remoteSha: r?.sha, source };
      if (conflict) entries.push({ ...base, category: 'CONFLICT', reason: conflict, operations: [] });
      else if (l && !r) entries.push({ ...base, category: 'ADD', operations: [{ action: 'ADD_REMOTE', path, sha: l.sha }] });
      else if (!l && r) entries.push({ ...base, category: 'DELETE', reason: 'Remote-only file; local Vault is authoritative.', operations: [{ action: 'DELETE_REMOTE', path }] });
      else if (l && r && l.sha !== r.sha) entries.push({ ...base, category: 'UPDATE', operations: [{ action: 'UPDATE_REMOTE', path, sha: l.sha }] });
      else entries.push({ ...base, category: 'UNCHANGED', operations: [] });
    }

    // A rename is presentation only. Require unique exact-content matches; never guess similarity.
    const adds = new Map<string, PlanEntry[]>();
    const deletes = new Map<string, PlanEntry[]>();
    for (const entry of entries) {
      if (entry.category === 'ADD') adds.set(entry.localSha!, [...(adds.get(entry.localSha!) ?? []), entry]);
      if (entry.category === 'DELETE') deletes.set(entry.remoteSha!, [...(deletes.get(entry.remoteSha!) ?? []), entry]);
    }
    const paired = new Set<PlanEntry>();
    const renames: PlanEntry[] = [];
    for (const [sha, candidates] of adds) {
      const old = deletes.get(sha);
      if (candidates.length === 1 && old?.length === 1) {
        const addition = candidates[0]!;
        const deletion = old[0]!;
        paired.add(addition); paired.add(deletion);
        renames.push({ category: 'RENAME', path: addition.path, oldPath: deletion.path, localSha: sha, remoteSha: sha,
          reason: 'Unique identical blob; represented as DELETE_REMOTE + ADD_REMOTE.',
          operations: [...deletion.operations, ...addition.operations] });
      }
    }
    const result = [...entries.filter(entry => !paired.has(entry)), ...renames].sort((a, b) => pathOrder(a.path, b.path));
    const counts = Object.fromEntries(CATEGORIES.map(category => [category, 0])) as Record<Category, number>;
    const operationCounts = { ADD_REMOTE: 0, UPDATE_REMOTE: 0, DELETE_REMOTE: 0 };
    result.forEach(entry => {
      counts[entry.category]++;
      entry.operations.forEach(operation => operationCounts[operation.action]++);
    });
    const scope = snapshotScope(local, remote, ignore);
    return { target: { owner: target.owner, repository: target.repository, branch: target.branch }, remoteHeadSha: remote.remoteHeadSha, remoteTreeSha: remote.treeSha,
      createdAt: new Date().toISOString(), localCount: scope.localFiles.length,
      remoteCount: scope.remoteFiles.length,
      counts, operationCounts, entries: result, protectedDirectories: [...local.protectedDirectories],
      deleteSafetyThreshold: threshold, highRisk: operationCounts.DELETE_REMOTE > threshold, hasConflicts: counts.CONFLICT > 0 };
  }
}
