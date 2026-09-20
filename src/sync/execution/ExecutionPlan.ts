import { PreviewError } from '../../errors';
import type { SyncManifest, ManifestFileEntry } from '../manifest/ManifestSchema';
import { parseManifest } from '../manifest/ManifestValidator';
import { identifyLocal } from '../identity/FileIdentity';
import { syncDomain } from '../identity/SyncDomain';
import { snapshotScope } from '../SnapshotScope';
import { ThreeWaySyncPlanner } from '../planner/ThreeWaySyncPlanner';
import { DECISIONS, type SyncDecision, type ThreeWayPlan } from '../planner/SyncDecision';
import { resolveFile } from '../planner/ThreeWayFileResolver';
import type { LocalSyncState } from '../state/LocalSyncState';
import type { PreviewSnapshotReader } from '../PreviewSnapshotReader';
import { pathConflictChecker } from '../../vault/PathConflictDetector';
import { pathOrder } from '../../vault/paths';

export type Capture = Awaited<ReturnType<PreviewSnapshotReader['read']>>;
export type Resolution = 'local' | 'remote';
export type SyncMode = 'SYNC' | 'INITIALIZE' | 'BOOTSTRAP' | 'ADOPT' | 'ATTACH' | 'SCOPE_REVIEW' | 'BLOCKED';
export interface ExecutionPlan { plan: ThreeWayPlan; mode: SyncMode; adoptionChoice?: Resolution; manifest: SyncManifest; before: Record<string, string>; after: Record<string, string>; excludedPaths: string[]; scopeKey: string }
export function compileExecution(capture: Capture, state: LocalSyncState, remoteManifest: SyncManifest | null,
  scopeKey: string, resolutions: Record<string, Resolution> = {}, identities: Record<string, string> = {}, adoptionChoice?: Resolution): ExecutionPlan {
  const { local, remote, ignore } = capture;
  let plan = new ThreeWaySyncPlanner().create({ local, remote, remoteManifest, base: state.baseManifest ?? null, localFiles: state.localFiles }, ignore);
  const scopeChanged = !!state.baseManifest && state.syncScope !== undefined && state.syncScope !== scopeKey;
  let mode: SyncMode = ({ READY: 'SYNC', INITIALIZE_REMOTE_FROM_LOCAL: 'INITIALIZE', BOOTSTRAP_FROM_REMOTE: 'BOOTSTRAP',
    LEGACY_REMOTE_REQUIRES_ADOPTION: 'ADOPT', BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY: 'ATTACH' } as Record<string, SyncMode>)[plan.status] ?? 'BLOCKED';
  if (scopeChanged && mode === 'SYNC') mode = 'SCOPE_REVIEW';
  if (adoptionChoice !== undefined && (mode !== 'ADOPT' || state.baseManifest || remoteManifest || !['local', 'remote'].includes(adoptionChoice))) {
    throw new PreviewError('PLAN', 'ADOPTION_NOT_ALLOWED', 'Global authority selection is only available before legacy repository adoption.');
  }
  const scope = snapshotScope(local, remote, ignore);
  const domain = syncDomain(state.baseManifest ?? null, remoteManifest, local, scope.remoteFiles, state.localFiles ?? {}, [], ignore);
  const manifest: SyncManifest = structuredClone(remoteManifest ?? { schemaVersion: 1, generation: 0, files: {} });
  const before = Object.fromEntries(domain.local.map(f => [f.path, f.sha]));
  const knownPaths = [...local.files.map(f => f.path), ...local.ignored.map(f => f.path), ...scope.remoteFiles.map(f => f.path),
    ...Object.values(state.baseManifest?.files ?? {}).map(f => f.path), ...Object.values(state.localFiles ?? {}).map(f => f.path), ...Object.values(manifest.files).map(f => f.path)];
  const excludedPaths = [...new Set(knownPaths.filter(path => !domain.eligible(path)))];
  const localById = identifyLocal(domain.local, domain.base, domain.manifest, domain.localFiles).matched;
  const localByPath = new Map(domain.local.map(f => [f.path, f]));
  let entries: SyncDecision[] = plan.entries.map(e => ({ ...e }));
  if (mode !== 'SYNC' && mode !== 'BLOCKED' && !adoptionChoice) {
    // No prior trusted common snapshot: form a union; absence is never deletion.
    entries = [];
    const paths = new Set(domain.local.map(f => f.path));
    if (!remoteManifest) for (const f of domain.remote) {
      const id = identities[f.path] ?? crypto.randomUUID();
      manifest.files[id] = { fileId: id, path: f.path, blobSha: f.sha, deleted: false, revision: 1 };
    }
    const livePaths = new Set(Object.values(manifest.files).filter(f => !f.deleted).map(f => f.path));
    for (const r of Object.values(manifest.files).filter(f => domain.eligible(f.path))) {
      const l = r.deleted && livePaths.has(r.path) ? undefined : localByPath.get(r.path);
      if (l) localById.set(r.fileId, { fileId: r.fileId, path: l.path, blobSha: l.sha, deleted: false });
      entries.push(resolveFile({ remote: r, local: l ? localById.get(r.fileId) : undefined })); paths.delete(r.path);
    }
    for (const path of paths) entries.push({ category: 'PUSH_ADD', path, localSha: localByPath.get(path)!.sha });
  }
  if (adoptionChoice) {
    // A deliberate, one-time authority choice has no historic identities or tombstones.
    // Reuse the same decisions, path checks, transaction executor and verification below.
    const remoteByPath = new Map(domain.remote.map(f => [f.path, f]));
    manifest.files = {}; manifest.generation = 1;
    entries = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])].map(path => {
      const localSha = localByPath.get(path)?.sha; const remoteSha = remoteByPath.get(path)?.sha;
      const sha = adoptionChoice === 'local' ? localSha : remoteSha;
      const fileId = sha ? identities[path] ?? crypto.randomUUID() : undefined;
      if (fileId && sha) manifest.files[fileId] = { fileId, path, blobSha: sha, deleted: false, revision: 1 };
      const category = localSha === remoteSha ? 'UNCHANGED' : adoptionChoice === 'local'
        ? !localSha ? 'PUSH_DELETE' : remoteSha ? 'PUSH_UPDATE' : 'PUSH_ADD'
        : !remoteSha ? 'PULL_DELETE' : localSha ? 'PULL_UPDATE' : 'PULL_ADD';
      return { category, path, fileId, localSha, remoteSha };
    });
  }
  const conflicts = pathConflictChecker([...new Set([...Object.keys(before), ...domain.remote.map(f => f.path)])], remote.entries, ignore);
  for (const entry of entries) {
    // Identity diagnostics still need the captured bytes for manual inspection.
    entry.localSha ??= entry.fileId ? localById.get(entry.fileId)?.blobSha : localByPath.get(entry.path)?.sha;
    entry.remoteSha ??= entry.fileId ? manifest.files[entry.fileId]?.blobSha : domain.remote.find(file => file.path === entry.path)?.sha;
    const problem = conflicts(entry.path, domain.remote.find(f => f.path === entry.path)) ?? (entry.oldPath ? conflicts(entry.oldPath) : undefined);
    if (problem) { entry.category = 'CONFLICT_IDENTITY_UNCERTAIN'; entry.reason = problem; }
    const choice = resolutions[entry.fileId ?? entry.path];
    if (!adoptionChoice && entry.category.startsWith('CONFLICT_') && choice && !problem) {
      entry.reason = `Explicit resolution: use ${choice.toUpperCase()} (other bytes retained in transaction backup).`;
      // An explicit choice accepts presence/absence as captured. Never guess a rename
      // for an untracked path: keeping it creates a fresh ID, keeping absence a tombstone.
      const unmatched = !entry.fileId ? localByPath.get(entry.path) : undefined;
      const l = entry.fileId ? localById.get(entry.fileId)
        : unmatched ? { path: unmatched.path, blobSha: unmatched.sha } : undefined;
      const r = entry.fileId ? manifest.files[entry.fileId]
        : Object.values(manifest.files).find(file => !file.deleted && file.path === entry.path);
      entry.category = choice === 'local' ? l ? !r || r.deleted ? 'PUSH_ADD' : 'PUSH_UPDATE' : !r || r.deleted ? 'UNCHANGED' : 'PUSH_DELETE'
        : !r || r.deleted ? 'PULL_DELETE' : l ? 'PULL_UPDATE' : 'PULL_ADD';
      entry.localSha = l?.blobSha; entry.remoteSha = r?.blobSha;
      if (choice === 'local') entry.path = l?.path ?? r?.path ?? entry.path;
      if (choice === 'remote' && r) entry.path = r.path;
      if (l && r && !r.deleted && l.path !== r.path) {
        entry.oldPath = choice === 'local' ? r.path : l.path;
        entry.category = choice === 'local' ? l.blobSha === r.blobSha ? 'PUSH_RENAME' : 'PUSH_RENAME_AND_UPDATE'
          : l.blobSha === r.blobSha ? 'PULL_RENAME' : 'PULL_RENAME_AND_UPDATE';
      }
    }
  }
  let changed = !remoteManifest && !adoptionChoice;
  for (const e of entries) {
    if (adoptionChoice || !e.category.startsWith('PUSH_')) continue;
    const previous = e.fileId ? manifest.files[e.fileId] : undefined;
    const deleted = e.category === 'PUSH_DELETE';
    const l = (e.fileId && localById.get(e.fileId)) || localByPath.get(e.path);
    const path = deleted ? previous?.path ?? e.path : l?.path ?? e.path;
    const sha = deleted ? previous?.blobSha : l && 'blobSha' in l ? l.blobSha : l && 'sha' in l ? l.sha : e.localSha;
    // A tombstone is immutable; recreating content always allocates a fresh identity.
    const id = !previous ? e.fileId ?? crypto.randomUUID() : previous.deleted && !deleted ? crypto.randomUUID() : previous.fileId;
    const next: ManifestFileEntry = { fileId: id, path, blobSha: sha, deleted, revision: id === previous?.fileId ? previous.revision + 1 : 1,
      lastChangedBy: state.deviceId, lastChangedAt: new Date().toISOString() };
    if (!deleted && !sha) throw new PreviewError('PLAN', 'MISSING_LOCAL_BYTES', 'Local identity has no matching content.');
    manifest.files[id] = next; changed = true;
  }
  if (changed) manifest.generation++;
  const after = Object.fromEntries(Object.values(manifest.files).filter(f => !f.deleted && domain.eligible(f.path)).map(f => [f.path, f.blobSha!]));
  const owners = new Map<string, number>();
  for (const file of Object.values(manifest.files).filter(f => !f.deleted)) owners.set(file.path, (owners.get(file.path) ?? 0) + 1);
  const destinationConflict = pathConflictChecker([...new Set([...Object.keys(after), ...local.ignored.map(f => f.path), ...excludedPaths])], remote.entries, ignore);
  for (const entry of entries) {
    const reason = (owners.get(entry.path) ?? 0) > 1
      ? 'Selected versions assign the same destination to multiple files. Choose the same side for the related conflicts, or rename a file and refresh.'
      : destinationConflict(entry.path);
    if (reason) { entry.category = 'CONFLICT_IDENTITY_UNCERTAIN'; entry.reason = reason; }
  }
  // Validate only executable plans: conflicting choices can temporarily share destinations.
  const hasConflicts = entries.some(e => e.category.startsWith('CONFLICT_'));
  if (!hasConflicts && mode !== 'BLOCKED') parseManifest(manifest);
  const counts = Object.fromEntries(DECISIONS.map(c => [c, 0])) as ThreeWayPlan['counts'];
  for (const entry of entries) counts[entry.category]++;
  entries.sort((a, b) => pathOrder(a.path, b.path));
  plan = { ...plan, entries, counts, hasConflicts };
  return { plan, mode, adoptionChoice, manifest, before, after, excludedPaths, scopeKey };
}
