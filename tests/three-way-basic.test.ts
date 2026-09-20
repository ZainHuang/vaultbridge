import { describe, expect, it } from 'vitest';
import { resolveFile } from '../src/sync/planner/ThreeWayFileResolver';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { version, manifestOf, ignore } from './stateful-helpers';
import { localSnapshot, remoteSnapshot } from './helpers';

describe('Three-way content matrix', () => {
  const rows = ['a', 'b', 'c'].flatMap(b => ['a', 'b', 'c'].flatMap(l => ['a', 'b', 'c'].map(r => ({ b, l, r,
    expected: l === b && r === b ? 'UNCHANGED' : l === r ? 'ALREADY_CONVERGED' : l === b ? 'PULL_UPDATE' : r === b ? 'PUSH_UPDATE' : 'CONFLICT_CONTENT' }))));
  it.each(rows)('$b / $l / $r → $expected', ({ b, l, r, expected }) => {
    expect(resolveFile({ base: version(b), local: version(l), remote: version(r) }).category).toBe(expected);
  });
  it('ten identical previews keep IDs, revisions and result bytes unchanged', () => {
    const local = localSnapshot({ 'B.md': 'B', 'A.md': 'A' });
    const remote = remoteSnapshot({ 'A.md': 'A', 'B.md': 'B' });
    const base = manifestOf(...local.files.map(f => ({ fileId: f.path, path: f.path, blobSha: f.sha, deleted: false, revision: 4 })));
    const input = { base, local, remote, remoteManifest: base };
    const before = JSON.stringify(input);
    const planner = new ThreeWaySyncPlanner();
    const plan = planner.create(input, ignore);
    expect(plan.entries.map(e => e.category)).toEqual(['UNCHANGED', 'UNCHANGED']);
    for (let i = 0; i < 10; i++) expect(planner.create(input, ignore)).toEqual(plan);
    expect(planner.create({ ...input, local: { ...local, files: [...local.files].reverse() }, remote: { ...remote, entries: [...remote.entries].reverse() } }, ignore)).toEqual(plan);
    expect(JSON.stringify(input)).toBe(before);
  });
});
