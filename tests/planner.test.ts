import { describe, expect, it } from 'vitest';
import { SyncPlanner } from '../src/sync/SyncPlanner';
import { IgnoreService } from '../src/vault/IgnoreService';
import { localSnapshot, remoteSnapshot, target } from './helpers';

const ignore = new IgnoreService({ includeObsidian: false, configDir: '.obsidian', gitignore: '*.mp3', patterns: '' });
const plan = (local: Record<string, string>, remote: Record<string, string>) => new SyncPlanner().create(localSnapshot(local), remoteSnapshot(remote), ignore, target);

describe('Local-authoritative planner', () => {
  it('plans add, update, delete, rename, unchanged and ignored with explicit operation counts', () => {
    const result = plan({ 'new.md': 'new', 'edit.md': 'after', 'renamed.md': 'move', 'same.md': 'same', 'audio.mp3': 'sound' }, { 'edit.md': 'before', 'old.md': 'move', 'legacy.md': 'legacy', 'same.md': 'same', 'audio.mp3': 'sound' });
    expect(result.counts).toEqual({ ADD: 1, UPDATE: 1, DELETE: 1, RENAME: 1, UNCHANGED: 1, IGNORED: 1, CONFLICT: 0 });
    expect(result.operationCounts).toEqual({ ADD_REMOTE: 2, UPDATE_REMOTE: 1, DELETE_REMOTE: 2 });
    expect(result.entries.find(entry => entry.category === 'RENAME')?.operations.map(op => [op.action, op.path])).toEqual([['DELETE_REMOTE', 'old.md'], ['ADD_REMOTE', 'renamed.md']]);
    expect(result.entries.find(entry => entry.path === 'legacy.md')?.operations[0]?.action).toBe('DELETE_REMOTE');
  });
  it('shows exactly 125 remote-only deletions for the 245 vs 370 example', () => {
    const local = Object.fromEntries(Array.from({ length: 245 }, (_, i) => [`note-${i}.md`, `${i}`]));
    const remote = { ...local, ...Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`legacy-${i}.md`, `legacy-${i}`])) };
    const result = plan(local, remote);
    expect(result.localCount).toBe(245); expect(result.remoteCount).toBe(370);
    expect(result.operationCounts.DELETE_REMOTE).toBe(125); expect(result.highRisk).toBe(true);
  });
  it('never guesses ambiguous or modified renames', () => {
    const result = plan({ 'new1.md': '', 'new2.md': '', 'new-edit.md': 'after' }, { 'old.md': '', 'old-edit.md': 'before' });
    expect(result.counts.RENAME).toBe(0); expect(result.counts.ADD).toBe(3); expect(result.counts.DELETE).toBe(2);
  });
  it('counts rename old paths towards the strict >20 risk boundary', () => {
    const local = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`new-${i}`, String(i)]));
    const remote = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`old-${i}`, String(i)]));
    expect(plan(local, remote).highRisk).toBe(false);
    expect(plan(local, { ...remote, legacy: 'extra' }).highRisk).toBe(true);
  });
  it.each([
    [{ 'A.md': 'A' }, { 'a.md': 'A' }],
    [{ 'café.md': 'A' }, { 'cafe\u0301.md': 'A' }],
    [{ 'Notes/a.md': 'A' }, { 'notes/b.md': 'B' }],
    [{ 'folder/a.md': 'A' }, { folder: 'B' }],
    [{ 'CON.md': 'A' }, {}],
    [{}, { 'bad?.md': 'A' }],
  ])('reports portable path conflicts without operations', (local, remote) => {
    const result = plan(local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.entries.every(entry => entry.category === 'CONFLICT' && !entry.operations.length)).toBe(true);
  });
  it('marks symlinks and gitlinks as conflicts', () => {
    const remote = remoteSnapshot({ link: 'target' });
    remote.entries[0]!.mode = '120000';
    remote.entries.push({ path: 'module', sha: 'd'.repeat(40), mode: '160000', type: 'commit' });
    const result = new SyncPlanner().create(localSnapshot({}), remote, ignore, target);
    expect(result.counts.CONFLICT).toBe(2); expect(result.operationCounts.DELETE_REMOTE).toBe(0);
  });
  it('does not copy settings or credentials into plan target', () => {
    const result = new SyncPlanner().create(localSnapshot({}), remoteSnapshot({}), ignore, { ...target, ...{ localToken: 'secret', secretName: 'key' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.target).toEqual(target);
  });
  it('empty/equal trees give an empty plan', () => {
    expect(plan({}, {}).entries).toEqual([]);
    expect(plan({ 'x.md': 'x' }, { 'x.md': 'x' }).counts.UNCHANGED).toBe(1);
  });
  it('ten seeded random edit rounds reconcile all eligible hashes using only the planned operations', () => {
    let seed = 90215;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    let local: Record<string, string> = { 'retained.md': 'retained' };
    let remote = { ...local };
    for (let round = 0; round < 10; round++) {
      local = { ...local };
      for (let i = 0; i < 40; i++) {
        const path = `note-${random() % 60}.md`;
        if (random() % 3 === 0) delete local[path];
        else local[path] = `round-${round}-${random()}`;
      }
      remote[`legacy-${round}.md`] = 'remote old';
      const result = plan(local, remote);
      const actual = new Map(remoteSnapshot(remote).entries.map(entry => [entry.path, entry.sha]));
      for (const entry of result.entries) for (const operation of entry.operations) {
        if (operation.action === 'DELETE_REMOTE') actual.delete(operation.path);
        else actual.set(operation.path, operation.sha!);
      }
      expect([...actual].sort()).toEqual(localSnapshot(local).files.map(file => [file.path, file.sha]).sort());
      remote = { ...local };
    }
  });
});
