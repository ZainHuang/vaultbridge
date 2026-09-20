import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/sync/manifest/ManifestValidator';
import { validateManifestHistory, validateManifestTree } from '../src/sync/manifest/ManifestConsistency';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { previewGroups, canExecutePreview, repositoryBlocked } from '../src/ui/PreviewModel';
import { manifestOf, version, ignore } from './stateful-helpers';
import { localSnapshot, remoteSnapshot } from './helpers';

function issues(run: () => unknown) {
  try { run(); throw new Error('Expected invalid manifest'); }
  catch (error) { return (error as { diagnostics: unknown[] }).diagnostics; }
}
describe('Manifest diagnostics retain exact evidence without file decisions', () => {
  it.each(['REMOTE_MANIFEST_INVALID', 'REMOTE_MANIFEST_MISSING', 'LOCAL_STATE_INVALID'] as const)('blocks %s even with stale caller flags', status => {
    const plan = new ThreeWaySyncPlanner().create({ base: null, local: localSnapshot({}), remote: remoteSnapshot({}), remoteManifest: manifestOf() }, ignore);
    plan.status = status;
    expect(repositoryBlocked(plan)).toBe(true);
    expect(canExecutePreview({ canExecute: true, mode: 'SYNC', plan })).toBe(false);
  });
  it('reports missing, untracked and changed paths together with expected/actual SHA', () => {
    const manifest = manifestOf(version('a', 'missing.md'), version('b', 'changed.md', false, 'id-2'));
    const tree = remoteSnapshot({ 'changed.md': 'changed', 'extra.md': 'new' });
    expect(issues(() => validateManifestTree(manifest, tree.entries, () => true))).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'LIVE_PATH_MISSING', path: 'missing.md', expectedSha: 'a'.repeat(40), actualSha: null }),
      expect.objectContaining({ kind: 'UNTRACKED_ELIGIBLE_PATH', path: 'extra.md', expectedSha: null, actualSha: tree.entries.find(f => f.path === 'extra.md')!.sha }),
      expect.objectContaining({ kind: 'BLOB_SHA_MISMATCH', path: 'changed.md', expectedSha: 'b'.repeat(40), actualSha: tree.entries.find(f => f.path === 'changed.md')!.sha }),
    ]));
  });
  it.each([
    ['DUPLICATE_FILE_ID', { schemaVersion: 1, generation: 1, files: { 'id-1': version(), alias: version() } }],
    ['DUPLICATE_LIVE_PATH', manifestOf(version(), version('b', 'A.md', false, 'id-2'))],
    ['INVALID_ENTRY_STATE', { ...manifestOf(), files: { 'id-1': { ...version(), deleted: 'false' } } }],
    ['INVALID_ENTRY_STATE', { ...manifestOf(), files: { 'id-1': { ...version(), blobSha: undefined } } }],
    ['SCHEMA_VALIDATION_FAILURE', { schemaVersion: 99 }],
  ])('distinguishes %s', (kind, value) => {
    expect(issues(() => parseManifest(value))).toEqual(expect.arrayContaining([expect.objectContaining({ kind })]));
  });
  it('preserves duplicate JSON identity evidence through the parser', () => {
    const entry = JSON.stringify(version());
    expect(issues(() => parseManifest(`{"schemaVersion":1,"generation":1,"files":{"id-1":${entry},"id-1":${entry}}}`)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'DUPLICATE_FILE_ID', fileId: 'id-1' })]));
  });
  it('reports generation/revision lineage and immutable tombstone failures', () => {
    expect(issues(() => validateManifestHistory({ ...manifestOf(version()), generation: 2 }, manifestOf(version()))))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'HISTORY_LINEAGE_MISMATCH', expected: 2, actual: 1 })]));
    expect(issues(() => validateManifestHistory(manifestOf(version('a', 'A.md', true)), { ...manifestOf(version()), generation: 2 })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'INVALID_ENTRY_STATE', path: 'A.md' })]));
  });
  it('surfaces detailed repository errors with Conflict 0 and refuses UI execution even with stale canExecute', () => {
    const plan = new ThreeWaySyncPlanner().create({ base: null, local: localSnapshot({}), remote: remoteSnapshot({}), remoteManifest: manifestOf(version()) }, ignore);
    expect(plan).toMatchObject({ status: 'REMOTE_MANIFEST_INVALID', entries: [] });
    expect(plan.reason).toContain('LIVE_PATH_MISSING'); expect(plan.reason).toContain('A.md'); expect(plan.reason).toContain('a'.repeat(40));
    expect(previewGroups(plan).Conflict).toBe(0);
    expect(canExecutePreview({ canExecute: true, mode: 'SYNC', plan })).toBe(false);
  });
});
