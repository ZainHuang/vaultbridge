import type { RemoteSnapshot } from '../../github/types';
import type { IgnoreService } from '../../vault/IgnoreService';
import { pathOrder } from '../../vault/paths';
import type { LocalSnapshot } from '../../vault/VaultScanner';
import type { BaseManifest, RemoteManifest } from '../manifest/ManifestSchema';
import { snapshotScope } from '../SnapshotScope';
import { DECISIONS, type SyncDecision, type ThreeWayPlan } from './SyncDecision';
import { resolveFile } from './ThreeWayFileResolver';
import { identifyLocal, type RenameEvent } from '../identity/FileIdentity';
import type { LocalFileState } from '../state/LocalSyncState';
import { detectBootstrap } from '../bootstrap/BootstrapDetector';
import { parseManifest, validFileMetadata } from '../manifest/ManifestValidator';
import { validateManifestHistory, validateManifestTree } from '../manifest/ManifestConsistency';
import { syncDomain } from '../identity/SyncDomain';
import { pathConflictChecker } from '../../vault/PathConflictDetector';
import { blockPathOwnershipCollisions } from '../identity/PathOwnership';
import { manifestErrorReason } from '../manifest/ManifestDiagnostics';

export interface ThreeWaySyncInput {
  base: BaseManifest | null;
  local: LocalSnapshot;
  remote: RemoteSnapshot;
  remoteManifest: unknown;
  localFiles?: Record<string, LocalFileState>;
  renameEvents?: RenameEvent[];
}
export class ThreeWaySyncPlanner {
  create(input: ThreeWaySyncInput, ignore: IgnoreService): ThreeWayPlan {
    let scope = snapshotScope(input.local, input.remote, ignore);
    const entries: SyncDecision[] = [];
    let base: BaseManifest | null;
    let remoteManifest: RemoteManifest | null = null;
    let gate: Pick<ThreeWayPlan, 'status' | 'reason'> = { status: 'READY' };
    const finish = (): ThreeWayPlan => {
      entries.sort((a, b) => pathOrder(a.path, b.path) || pathOrder(a.fileId ?? '', b.fileId ?? ''));
      const counts = Object.fromEntries(DECISIONS.map(category => [category, 0])) as ThreeWayPlan['counts'];
      for (const entry of entries) counts[entry.category]++;
      return { ...gate, deviceState: input.base ? 'SYNC HISTORY PRESENT' : 'NEW DEVICE', remoteGeneration: remoteManifest?.generation,
        remoteHeadSha: input.remote.remoteHeadSha, localCount: scope.localFiles.length, remoteCount: scope.remoteFiles.length,
        entries, counts, hasConflicts: gate.status.includes('CONFLICT') || entries.some(e => e.category.startsWith('CONFLICT_')), executionAllowed: false };
    };
    try {
      base = input.base === null ? null : parseManifest(input.base);
      const paths = new Set<string>();
      for (const [id, entry] of Object.entries(input.localFiles ?? {})) {
        if (!validFileMetadata(entry, true) || id !== entry.fileId || (!entry.deleted && paths.has(entry.path))) throw new Error();
        if (!entry.deleted) paths.add(entry.path);
      }
      if (new Set(scope.localFiles.map(file => file.path)).size !== scope.localFiles.length) throw new Error();
    } catch { gate = { status: 'LOCAL_STATE_INVALID', reason: 'Invalid local base or identity state. No file decisions were generated.' }; return finish(); }
    try {
      remoteManifest = input.remoteManifest === null ? null : parseManifest(input.remoteManifest);
    } catch (error) { gate = { status: 'REMOTE_MANIFEST_INVALID', reason: manifestErrorReason(error) }; return finish(); }
    const domain = syncDomain(base, remoteManifest, input.local, scope.remoteFiles, input.localFiles ?? {}, input.renameEvents ?? [], ignore);
    base = domain.base; remoteManifest = domain.manifest;
    scope = { ...scope, localFiles: domain.local, remoteFiles: domain.remote };
    try {
      if (remoteManifest) { validateManifestHistory(base, remoteManifest); validateManifestTree(remoteManifest, scope.remoteFiles, domain.eligible); }
    } catch (error) { gate = { status: 'REMOTE_MANIFEST_INVALID', reason: manifestErrorReason(error) }; return finish(); }
    gate = detectBootstrap(base, remoteManifest, scope.localFiles.length, scope.remoteFiles.length);
    if (gate.status !== 'READY') return finish();
    const identity = identifyLocal(scope.localFiles, base, remoteManifest, domain.localFiles, domain.events);
    const ids = new Set([...Object.keys(base?.files ?? {}), ...Object.keys(remoteManifest?.files ?? {}), ...Object.keys(domain.localFiles)]);
    for (const id of [...ids].sort(pathOrder)) {
      const baseEntry = base?.files[id];
      const remote = remoteManifest?.files[id];
      const recorded = domain.localFiles[id];
      const local = identity.matched.get(id) ?? (recorded?.deleted || (!baseEntry && !remote && recorded) ? { ...recorded!, deleted: true } : undefined);
      entries.push(identity.uncertainIds.has(id)
        ? { category: 'CONFLICT_IDENTITY_UNCERTAIN', fileId: id, path: baseEntry?.path ?? remote!.path, reason: 'Missing tracked path and unexplained local files; rename identity is uncertain.' }
        : resolveFile({ base: baseEntry, local, remote }));
    }
    for (const local of identity.remaining.values()) entries.push(identity.uncertainPaths.has(local.path)
      ? { category: 'CONFLICT_IDENTITY_UNCERTAIN', path: local.path, reason: 'This path may be a renamed and edited tracked file.' }
      : resolveFile({ local: { fileId: '', path: local.path, blobSha: local.sha, deleted: false } }));
    blockPathOwnershipCollisions(entries, entry => !entry.fileId || identity.matched.has(entry.fileId) || !remoteManifest?.files[entry.fileId]?.deleted);
    const conflict = pathConflictChecker([...new Set([...scope.localFiles.map(file => file.path), ...scope.remoteFiles.map(file => file.path)])], input.remote.entries, ignore);
    for (const entry of entries) {
      const reason = conflict(entry.path) ?? (entry.oldPath ? conflict(entry.oldPath) : undefined);
      if (reason) { entry.category = 'CONFLICT_IDENTITY_UNCERTAIN'; entry.reason = reason; }
    }
    return finish();
  }
}
