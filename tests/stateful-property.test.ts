import { describe, expect, it } from 'vitest';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import type { DecisionCategory } from '../src/sync/planner/SyncDecision';
import type { ManifestFileEntry, SyncManifest } from '../src/sync/manifest/ManifestSchema';
import { ignore, manifestOf } from './stateful-helpers';
import { bytes, referenceSha, HEAD, TREE } from './helpers';

type File = ManifestFileEntry;
const live = (file?: File) => !!file && !file.deleted;
const content = (file?: File) => live(file) ? `${file!.path}\0${file!.blobSha}` : null;
// Independent oracle compares logical values, then interprets the two change sets.
function oracle(base: File | undefined, local: File | undefined, remote: File | undefined): DecisionCategory {
  const b = content(base), l = content(local), r = content(remote);
  if (base?.deleted) return l === null && r === null ? 'UNCHANGED' : 'CONFLICT_DELETE_MODIFY';
  if (!base) {
    if (remote?.deleted) return l === null ? 'UNCHANGED' : 'CONFLICT_DELETE_MODIFY';
    if (l === null) return r === null ? 'UNCHANGED' : 'PULL_ADD';
    if (r === null) return 'PUSH_ADD';
    return l === r ? 'ALREADY_CONVERGED' : 'CONFLICT_ADD_ADD';
  }
  if (l === r) return l === b ? 'UNCHANGED' : 'ALREADY_CONVERGED';
  if (l === null || r === null) {
    if (l === b) return 'PULL_DELETE';
    if (r === b) return 'PUSH_DELETE';
    return 'CONFLICT_DELETE_MODIFY';
  }
  const changed = (file: File) => new Set([
    ...(file.path !== base.path ? ['path'] : []), ...(file.blobSha !== base.blobSha ? ['content'] : []),
  ]);
  const left = changed(local!), right = changed(remote!);
  if (left.has('path') && right.has('path') && local!.path !== remote!.path) return 'CONFLICT_RENAME_RENAME';
  if (!right.size || !left.size) {
    const changes = right.size ? right : left;
    const suffix = changes.has('path') ? changes.has('content') ? 'RENAME_AND_UPDATE' : 'RENAME' : 'UPDATE';
    return `${right.size ? 'PULL' : 'PUSH'}_${suffix}` as DecisionCategory;
  }
  if (local!.path === remote!.path) {
    if (!right.has('content')) return 'PUSH_UPDATE';
    if (!left.has('content')) return 'PULL_UPDATE';
  }
  return 'CONFLICT_CONTENT';
}

describe('A / B / Remote seeded state machine', () => {
  it.each(Array.from({ length: 100 }, (_, index) => index + 1))('seed %i: 50 edits/adds/deletes/renames with independent oracle', seed => {
    let random = seed;
    const next = (n: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % n; };
    const hash = (text: string) => referenceSha(bytes(text));
    const make = (id: string): File => ({ fileId: id, path: `${id}.md`, blobSha: hash(id), deleted: false, revision: 1 });
    let remote: SyncManifest = manifestOf(make('f-0'), make('f-1'), make('f-2'));
    const devices = [0, 1].map(() => ({ base: structuredClone(remote), files: structuredClone(remote.files) }));
    const planner = new ThreeWaySyncPlanner();
    for (let step = 0; step < 50; step++) {
      const device = devices[next(2)]!;
      const alive = Object.values(device.files).filter(live);
      const operation = step < 4 ? step : next(4);
      if (operation === 0 || !alive.length) {
        const id = `s${seed}-new-${step}`; device.files[id] = make(id);
      } else {
        const selected = alive[next(alive.length)]!;
        if (operation === 1) selected.blobSha = hash(`${seed}-${step}`);
        if (operation === 2) selected.deleted = true;
        if (operation === 3) selected.path = `renamed-${step}-${selected.fileId}.md`;
      }
      for (const candidate of devices) {
        const input = {
          base: candidate.base, remoteManifest: remote, localFiles: candidate.files,
          local: { scannedAt: 'not-used', ignored: [], protectedDirectories: [], files: Object.values(candidate.files).filter(live).map(f => ({ path: f.path, sha: f.blobSha!, size: 1 })) },
          remote: { remoteHeadSha: HEAD, treeSha: TREE, fetchedAt: 'not-used', entries: Object.values(remote.files).filter(live).map(f => ({ path: f.path, sha: f.blobSha!, size: 1, type: 'blob' as const, mode: '100644' })) },
        };
        const before = JSON.stringify(input);
        const plan = planner.create(input, ignore);
        expect(plan.status, `seed=${seed} step=${step}`).toBe('READY');
        const ids = [...new Set([...Object.keys(candidate.base.files), ...Object.keys(candidate.files), ...Object.keys(remote.files)])];
        expect(plan.entries).toHaveLength(ids.length);
        expect(new Set(plan.entries.map(e => e.fileId)).size).toBe(ids.length);
        for (const id of ids) {
          const expected = oracle(candidate.base.files[id], candidate.files[id], remote.files[id]);
          expect(plan.entries.find(e => e.fileId === id)?.category, `seed=${seed} step=${step} file=${id}`).toBe(expected);
        }
        expect(JSON.stringify(input)).toBe(before);
        expect(planner.create({ ...input, local: { ...input.local, files: [...input.local.files].reverse() }, remote: { ...input.remote, entries: [...input.remote.entries].reverse() } }, ignore)).toEqual(plan);
        // A test-only oracle executor advances history only when all decisions are safe.
        // No production executor or network/file write is used by this simulation.
        if (step % 3 === 0 && !plan.hasConflicts) {
          let published = false;
          const updated = structuredClone(remote);
          for (const id of ids) {
            const expected = oracle(candidate.base.files[id], candidate.files[id], remote.files[id]);
            if (expected.startsWith('PUSH_')) {
              updated.files[id] = { ...candidate.files[id]!, revision: (remote.files[id]?.revision ?? 0) + 1 };
              published = true;
            }
          }
          if (published) updated.generation++;
          remote = updated;
          candidate.base = structuredClone(remote); candidate.files = structuredClone(remote.files);
        }
      }
    }
  });
});
