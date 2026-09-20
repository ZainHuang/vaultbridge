import { describe, expect, it } from 'vitest';
import { resolveFile } from '../src/sync/planner/ThreeWayFileResolver';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { version, manifestOf, ignore } from './stateful-helpers';
import { localSnapshot, remoteSnapshot } from './helpers';
describe('Add matrix', () => {
  it.each([
    [version(), undefined, 'PUSH_ADD'],
    [undefined, version(), 'PULL_ADD'],
    [version(), version(), 'ALREADY_CONVERGED'],
    [version(), version('b'), 'CONFLICT_ADD_ADD'],
    [undefined, version('a', 'A.md', true), 'UNCHANGED'],
    [version(), version('a', 'A.md', true), 'CONFLICT_DELETE_MODIFY'],
  ] as const)('new identity case %#', (local, remote, expected) => expect(resolveFile({ local, remote }).category).toBe(expected));
  it('plans additions in both directions and add/add collisions', () => {
    const local = localSnapshot({ 'local.md': 'x', 'same.md': 'same', 'conflict.md': 'L' });
    const remote = remoteSnapshot({ 'remote.md': 'y', 'same.md': 'same', 'conflict.md': 'R' });
    const remoteManifest = { ...manifestOf(...remote.entries.map(e => ({ ...version(), fileId: e.path, path: e.path, blobSha: e.sha }))), generation: 2 };
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(), local, remote, remoteManifest }, ignore);
    expect(plan.entries.map(e => [e.path, e.category])).toEqual([
      ['conflict.md', 'CONFLICT_ADD_ADD'], ['local.md', 'PUSH_ADD'], ['remote.md', 'PULL_ADD'], ['same.md', 'ALREADY_CONVERGED'],
    ]);
    expect(plan.entries.find(e => e.path === 'local.md')?.fileId).toBeUndefined();
  });
  it.each(['known deletion', 'unseen remote addition'])('245 local / 370 remote: %s gets the correct direction', kind => {
    const all = Object.fromEntries(Array.from({ length: 370 }, (_, i) => [`note-${i}.md`, `content-${i}`]));
    const local = localSnapshot(Object.fromEntries(Object.entries(all).slice(0, 245)));
    const remote = remoteSnapshot(all);
    const entries = remote.entries.map(e => ({ ...version(), fileId: e.path, path: e.path, blobSha: e.sha }));
    const plan = new ThreeWaySyncPlanner().create({ local, remote, remoteManifest: { ...manifestOf(...entries), generation: 2 },
      base: manifestOf(...(kind === 'known deletion' ? entries : entries.slice(0, 245))) }, ignore);
    expect(plan.counts.UNCHANGED).toBe(245);
    expect(plan.counts.PUSH_DELETE).toBe(kind === 'known deletion' ? 125 : 0);
    expect(plan.counts.PULL_ADD).toBe(kind === 'unseen remote addition' ? 125 : 0);
  });
});
