import { describe, expect, it } from 'vitest';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { manifestOf, ignore, version } from './stateful-helpers';
import { localSnapshot, remoteSnapshot } from './helpers';
describe('Fail-closed manifest boundary', () => {
  const local = localSnapshot({ 'A.md': 'old' }); const remote = remoteSnapshot({ 'A.md': 'old' });
  const entry = { ...version(), blobSha: local.files[0]!.sha, revision: 4 };
  const base = { ...manifestOf(entry), generation: 5 };
  it.each([
    '{', { schemaVersion: 9 }, { ...base, generation: -1 },
    { ...base, files: { a: entry, b: entry } },
    { ...base, files: { 'id-1': { ...entry, path: '../unsafe' } } },
    { ...base, files: { 'id-1': { ...entry, revision: -1 } } },
    { ...base, files: { 'id-1': { deleted: true, revision: 4 } } },
    { ...base, files: { 'id-1': entry, other: { ...entry, fileId: 'other' } } },
  ])('rejects corrupt input before generating a partial plan %#', remoteManifest => {
    const plan = new ThreeWaySyncPlanner().create({ base, local, remote, remoteManifest }, ignore);
    expect(plan.status).toBe('REMOTE_MANIFEST_INVALID'); expect(plan.entries).toEqual([]);
  });
  it.each([
    ['tree hash differs', { ...base, files: { 'id-1': { ...entry, blobSha: 'b'.repeat(40) } } }],
    ['generation rollback', { ...base, generation: 4 }],
    ['revision rollback', { ...base, generation: 6, files: { 'id-1': { ...entry, revision: 3 } } }],
    ['dropped identity', { ...base, generation: 6, files: {} }],
    ['tombstone still has a tree blob', { ...base, generation: 6, files: { 'id-1': { ...entry, deleted: true, revision: 5 } } }],
  ])('blocks %s', (_, remoteManifest) => {
    expect(new ThreeWaySyncPlanner().create({ base, local, remote, remoteManifest }, ignore)).toMatchObject({ status: 'REMOTE_MANIFEST_INVALID', entries: [] });
  });
  it('requires revisions and generations to advance when metadata changes', () => {
    const changed = { ...entry, blobSha: remoteSnapshot({ 'A.md': 'new' }).entries[0]!.sha };
    for (const manifest of [{ ...base, files: { 'id-1': changed } }, { ...base, generation: 6, files: { 'id-1': changed } }]) {
      expect(new ThreeWaySyncPlanner().create({ base, local, remote: remoteSnapshot({ 'A.md': 'new' }), remoteManifest: manifest }, ignore).status).toBe('REMOTE_MANIFEST_INVALID');
    }
  });
  it('rejects a remote user file missing from its manifest', () => {
    expect(new ThreeWaySyncPlanner().create({ base: manifestOf(), local, remote, remoteManifest: manifestOf() }, ignore).status).toBe('REMOTE_MANIFEST_INVALID');
  });
  it('rejects a duplicated snapshot and corrupt local identity without a partial plan', () => {
    const planner = new ThreeWaySyncPlanner();
    expect(planner.create({ base, local: { ...local, files: [...local.files, ...local.files] }, remote, remoteManifest: base }, ignore)).toMatchObject({ status: 'LOCAL_STATE_INVALID', entries: [] });
    expect(planner.create({ base, local, remote, remoteManifest: base, localFiles: { wrong: version() } }, ignore).status).toBe('LOCAL_STATE_INVALID');
  });
  it('forbids reusing a tombstoned identity', () => {
    const tombstone = { ...base, files: { 'id-1': { ...entry, deleted: true } } };
    const revived = { ...base, generation: 6, files: { 'id-1': { ...entry, revision: 5 } } };
    expect(new ThreeWaySyncPlanner().create({ base: tombstone, local, remote, remoteManifest: revived }, ignore).status).toBe('REMOTE_MANIFEST_INVALID');
  });
});
