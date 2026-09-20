import { describe, expect, it } from 'vitest';
import { resolveFile } from '../src/sync/planner/ThreeWayFileResolver';
import { version, manifestOf, ignore } from './stateful-helpers';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { localSnapshot, remoteSnapshot } from './helpers';
describe('Deletion matrix and resurrection regression', () => {
  it.each([
    [undefined, version(), 'PUSH_DELETE'],
    [version(), version('a', 'A.md', true), 'PULL_DELETE'],
    [undefined, version('a', 'A.md', true), 'ALREADY_CONVERGED'],
    [undefined, version('b'), 'CONFLICT_DELETE_MODIFY'],
    [version('b'), version('a', 'A.md', true), 'CONFLICT_DELETE_MODIFY'],
    [version('a', 'A.md', true), version(), 'PUSH_DELETE'],
    [version(), undefined, 'CONFLICT_IDENTITY_UNCERTAIN'],
  ] as const)('deletion case %# → %s', (local, remote, expected) => {
    expect(resolveFile({ base: version(), local, remote }).category).toBe(expected);
  });
  it('an offline second device must pull the tombstone rather than resurrect its old note', () => {
    const local = localSnapshot({ 'A.md': 'old' });
    const entry = { ...version(), blobSha: local.files[0]!.sha };
    const remoteManifest = { ...manifestOf({ ...entry, deleted: true, revision: 2 }), generation: 2 };
    const result = new ThreeWaySyncPlanner().create({ base: manifestOf(entry), local, remote: remoteSnapshot({}), remoteManifest }, ignore);
    expect(result.entries.map(e => e.category)).toEqual(['PULL_DELETE']);
    expect(result.counts.PUSH_ADD).toBe(0);
    expect(remoteManifest.files['id-1']?.deleted).toBe(true);
  });
  it('a base tombstone cannot silently treat a reappearing file as unchanged', () => {
    expect(resolveFile({ base: version('a', 'A.md', true), local: version(), remote: version('a', 'A.md', true) }).category).toBe('CONFLICT_DELETE_MODIFY');
    expect(resolveFile({ base: version('a', 'A.md', true), remote: version('a', 'A.md', true) }).category).toBe('UNCHANGED');
  });
});
