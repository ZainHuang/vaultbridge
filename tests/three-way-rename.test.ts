import { describe, expect, it } from 'vitest';
import { resolveFile } from '../src/sync/planner/ThreeWayFileResolver';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { version, manifestOf, ignore } from './stateful-helpers';
import { localSnapshot, remoteSnapshot } from './helpers';
import type { LocalFileState } from '../src/sync/state/LocalSyncState';
describe('Rename identity', () => {
  it.each([
    [version('a', 'B.md'), version(), 'PUSH_RENAME'],
    [version(), version('a', 'B.md'), 'PULL_RENAME'],
    [version('a', 'B.md'), version('a', 'B.md'), 'ALREADY_CONVERGED'],
    [version('a', 'B.md'), version('a', 'C.md'), 'CONFLICT_RENAME_RENAME'],
    [version('b', 'B.md'), version(), 'PUSH_RENAME_AND_UPDATE'],
    [version(), version('b', 'B.md'), 'PULL_RENAME_AND_UPDATE'],
    [version('a', 'B.md'), version('b'), 'CONFLICT_CONTENT'],
    [version('b'), version('a', 'B.md'), 'CONFLICT_CONTENT'],
    [version('a', 'B.md'), version('a', 'A.md', true), 'CONFLICT_DELETE_MODIFY'],
    [version('a', 'B.md', false, 'wrong-id'), version(), 'CONFLICT_IDENTITY_UNCERTAIN'],
  ] as const)('rename matrix %#', (local, remote, expected) => expect(resolveFile({ base: version(), local, remote }).category).toBe(expected));

  const setup = (contents = 'old') => {
    const remote = remoteSnapshot({ 'A.md': 'old' });
    const base = manifestOf({ ...version(), blobSha: remote.entries[0]!.sha });
    return { base, remoteManifest: base, remote, local: localSnapshot({ 'B.md': contents }) };
  };
  it('stable local fileId supports rename plus edit and retains identity', () => {
    const input = setup('edited');
    const localFiles: Record<string, LocalFileState> = { 'id-1': { fileId: 'id-1', path: 'B.md', blobSha: input.local.files[0]!.sha, deleted: false } };
    const plan = new ThreeWaySyncPlanner().create({ ...input, localFiles }, ignore);
    expect(plan.entries).toMatchObject([{ category: 'PUSH_RENAME_AND_UPDATE', fileId: 'id-1', oldPath: 'A.md', path: 'B.md' }]);
  });
  it('explicit rename events prove identity even when contents changed', () => {
    const plan = new ThreeWaySyncPlanner().create({ ...setup('edited'), renameEvents: [{ oldPath: 'A.md', path: 'B.md' }] }, ignore);
    expect(plan.entries).toMatchObject([{ category: 'PUSH_RENAME_AND_UPDATE', fileId: 'id-1' }]);
  });
  it('a unique exact hash remains a conservative fallback', () => {
    expect(new ThreeWaySyncPlanner().create(setup(), ignore).entries).toMatchObject([{ category: 'PUSH_RENAME', fileId: 'id-1' }]);
  });
  it('unproven rename plus edit blocks both the missing and new paths', () => {
    const plan = new ThreeWaySyncPlanner().create(setup('edited'), ignore);
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(plan.entries.every(e => e.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
  });
  it('ambiguous identical hashes never choose a candidate by iteration order', () => {
    const input = setup(); input.local = localSnapshot({ 'B.md': 'old', 'C.md': 'old' });
    const plan = new ThreeWaySyncPlanner().create(input, ignore);
    expect(plan.entries.every(e => e.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
  });
  it('fileId wins over a contradictory event and hash candidate', () => {
    const input = setup('edited'); input.local = localSnapshot({ 'B.md': 'edited', 'C.md': 'old' });
    const plan = new ThreeWaySyncPlanner().create({ ...input, localFiles: { 'id-1': { ...version('b', 'B.md') } }, renameEvents: [{ oldPath: 'A.md', path: 'C.md' }] }, ignore);
    expect(plan.entries.find(e => e.fileId === 'id-1')).toMatchObject({ category: 'PUSH_RENAME_AND_UPDATE', path: 'B.md' });
    expect(plan.entries.find(e => e.path === 'C.md')?.category).toBe('PUSH_ADD');
  });
});
