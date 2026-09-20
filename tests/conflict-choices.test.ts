import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
async function device(remote: GitFixture, files: Record<string, string> = {}) {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: value => vault.writeInternal('state', value) });
  await state.load();
  const service = new SyncService(vault, remote.transport, '.obsidian', state);
  const sync = async () => service.execute(await service.preview(options, 'test'), 'test');
  return { vault, state, service, sync };
}

describe('explicit per-file and all-conflict authority choices', () => {
  it.each(['local', 'remote'] as const)('all %s resolves content conflicts without replacing unrelated one-sided changes', async choice => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a', 'B.md': 'b' }); await a.sync();
    const b = await device(remote); await b.sync();
    for (const path of ['A.md', 'B.md']) { a.vault.files.set(path, bytes('remote')); b.vault.files.set(path, bytes('local')); }
    a.vault.files.set('remote-only.md', bytes('keep remote')); await a.sync();
    b.vault.files.set('local-only.md', bytes('keep local'));
    const preview = await b.service.preview(options, 'test'); const before = b.state.current(); const head = remote.head;
    expect(preview.plan.counts.CONFLICT_CONTENT).toBe(2);
    const resolved = b.service.resolveAll(preview, choice);
    expect(resolved.canExecute).toBe(true); expect(remote.head).toBe(head); expect(b.state.current()).toEqual(before);
    expect(resolved.plan.counts.PUSH_ADD).toBe(1); expect(resolved.plan.counts.PULL_ADD).toBe(1);
    await b.service.execute(resolved, 'test');
    for (const path of ['A.md', 'B.md']) { expect(remote.text(path)).toBe(choice); expect(b.vault.files.get(path)).toEqual(bytes(choice)); }
    expect(remote.text('remote-only.md')).toBe('keep remote'); expect(remote.text('local-only.md')).toBe('keep local');
    expect((await b.service.preview(options, 'test')).plan.hasConflicts).toBe(false);
  });
  it.each(['local', 'remote'] as const)('explicit %s resolves uncertain missing/new paths without guessing a rename or reusing an ID', async choice => {
    const remote = new GitFixture(); const a = await device(remote, { 'original.md': 'old' }); await a.sync();
    const id = Object.keys(a.state.current().baseManifest!.files)[0]!;
    // Simulate a rename+edit outside Obsidian, without an identity event.
    a.vault.files.delete('original.md'); a.vault.files.set('untracked.md', bytes('edited'));
    const preview = await a.service.preview({ ...options, deleteSafetyThreshold: 0 }, 'test');
    expect(preview.plan.counts.CONFLICT_IDENTITY_UNCERTAIN).toBe(2);
    const resolved = a.service.resolveAll(preview, choice);
    expect(resolved.canExecute).toBe(true); expect(resolved.requiresDeleteConfirmation).toBe(true);
    await expect(a.service.execute(resolved, 'test')).rejects.toThrow('DELETE');
    await a.service.execute(resolved, 'test', () => {}, undefined, `DELETE ${resolved.deletions}`);
    const manifest = a.state.current().baseManifest!;
    if (choice === 'local') {
      expect(manifest.files[id]!.deleted).toBe(true);
      expect(Object.values(manifest.files).find(file => !file.deleted)?.fileId).not.toBe(id);
      expect(remote.text('untracked.md')).toBe('edited'); expect(remote.contents()['original.md']).toBeUndefined();
    } else {
      expect(manifest.files[id]!.deleted).toBe(false);
      expect(a.vault.files.get('original.md')).toEqual(bytes('old')); expect(a.vault.files.has('untracked.md')).toBe(false);
    }
    expect((await a.service.preview(options, 'test')).plan.hasConflicts).toBe(false);
  });
  it('individual uncertain choices leave the other conflict unresolved', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'old' }); await a.sync();
    a.vault.files.delete('A.md'); a.vault.files.set('B.md', bytes('edited'));
    const preview = await a.service.preview(options, 'test');
    const inspection = await a.service.inspect(preview, preview.plan.entries.find(entry => entry.path === 'B.md')!, 'test');
    expect(inspection).toContain('edited');
    const resolved = a.service.resolve(preview, 'B.md', 'local');
    expect(resolved.plan.counts.PUSH_ADD).toBe(1); expect(resolved.plan.counts.CONFLICT_IDENTITY_UNCERTAIN).toBe(1);
    expect(resolved.canExecute).toBe(false);
  });
  it('batch resolution uses the captured plan and still blocks a changed HEAD', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync();
    const b = await device(remote); await b.sync();
    a.vault.files.set('A.md', bytes('remote')); await a.sync(); b.vault.files.set('A.md', bytes('local'));
    const preview = await b.service.preview(options, 'test'); preview.plan.entries = [];
    const resolved = b.service.resolveAll(preview, 'remote'); expect(resolved.canExecute).toBe(true);
    remote.external({ 'other.md': 'new head' });
    await expect(b.service.execute(resolved, 'test')).rejects.toThrow();
    expect(b.vault.files.get('A.md')).toEqual(bytes('local'));
  });
  it('does not turn repository corruption or invalid destination paths into executable plans', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'old' }); await a.sync();
    a.vault.files.set('a.md', bytes('case collision'));
    const preview = await a.service.preview(options, 'test');
    expect(a.service.resolveAll(preview, 'local').canExecute).toBe(false);
    remote.external({ 'A.md': 'missing manifest' });
    const invalid = await a.service.preview(options, 'test');
    expect(() => a.service.resolveAll(invalid, 'remote')).toThrow();
  });
  it.each(['local', 'remote'] as const)('%s resolves a remote rename colliding with a separate local addition', async choice => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'tracked' }); await a.sync();
    const b = await device(remote); await b.sync();
    a.vault.files.set('B.md', bytes('tracked')); a.vault.files.delete('A.md'); await a.state.recordRename('A.md', 'B.md'); await a.sync();
    b.vault.files.set('B.md', bytes('separate local addition'));
    const preview = await b.service.preview(options, 'test'); expect(preview.plan.counts.CONFLICT_IDENTITY_UNCERTAIN).toBe(2);
    const resolved = b.service.resolveAll(preview, choice); expect(resolved.canExecute).toBe(true);
    if (choice === 'remote') expect(resolved.plan.counts.PULL_DELETE).toBe(0);
    await b.service.execute(resolved, 'test');
    expect(remote.text('B.md')).toBe(choice === 'local' ? 'separate local addition' : 'tracked');
    expect(b.vault.files.has('A.md')).toBe(choice === 'local');
    expect((await b.service.preview(options, 'test')).plan.hasConflicts).toBe(false);
  });
  it.each(['local', 'remote'] as const)('%s resolves a reused tombstone path without resurrecting the tombstone', async choice => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'old' }); await a.sync();
    const b = await device(remote); await b.sync(); const oldId = Object.keys(b.state.current().baseManifest!.files)[0]!;
    a.vault.files.delete('A.md'); await a.state.recordDelete('A.md'); await a.sync();
    a.vault.files.set('A.md', bytes('new remote')); await a.state.recordCreate('A.md'); await a.sync();
    const tombstone = a.state.current().baseManifest!.files[oldId];
    const preview = await b.service.preview(options, 'test'); expect(preview.plan.hasConflicts).toBe(true);
    const resolved = b.service.resolveAll(preview, choice); expect(resolved.canExecute).toBe(true);
    await b.service.execute(resolved, 'test');
    expect(b.state.current().baseManifest!.files[oldId]).toEqual(tombstone);
    expect(remote.text('A.md')).toBe(choice === 'local' ? 'old' : 'new remote');
    expect((await b.service.preview(options, 'test')).plan.hasConflicts).toBe(false);
  });
  it.each(['local', 'remote'] as const)('%s resolves two files swapping paths atomically, preserving stable IDs', async choice => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'alpha', 'B.md': 'beta' }); await a.sync();
    const b = await device(remote); await b.sync(); const ids = Object.keys(b.state.current().baseManifest!.files).sort();
    const original = JSON.parse(remote.text('.local-mirror-sync/manifest.json'));
    for (const file of Object.values(original.files) as { path: string; revision: number }[]) { file.path = file.path === 'A.md' ? 'B.md' : 'A.md'; file.revision++; }
    original.generation++;
    remote.external({ 'A.md': 'beta', 'B.md': 'alpha', '.local-mirror-sync/manifest.json': JSON.stringify(original) });
    const preview = await b.service.preview(options, 'test'); expect(preview.plan.counts.CONFLICT_IDENTITY_UNCERTAIN).toBe(2);
    const resolved = b.service.resolveAll(preview, choice); expect(resolved.canExecute).toBe(true);
    await b.service.execute(resolved, 'test');
    expect(remote.text('A.md')).toBe(choice === 'local' ? 'alpha' : 'beta');
    expect(remote.text('B.md')).toBe(choice === 'local' ? 'beta' : 'alpha');
    expect(Object.keys(b.state.current().baseManifest!.files).sort()).toEqual(ids);
  });
  it('a mixed choice that assigns two owners to one destination remains reviewable and blocked', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a', 'B.md': 'b' }); await a.sync();
    const original = JSON.parse(remote.text('.local-mirror-sync/manifest.json'));
    for (const file of Object.values(original.files) as { path: string; revision: number }[]) { file.path = file.path === 'A.md' ? 'B.md' : 'A.md'; file.revision++; }
    original.generation++;
    remote.external({ 'A.md': 'b', 'B.md': 'a', '.local-mirror-sync/manifest.json': JSON.stringify(original) });
    const preview = await a.service.preview(options, 'test');
    const chosen = a.service.resolve(preview, preview.plan.entries[0]!.fileId!, 'local');
    expect(chosen.canExecute).toBe(false); expect(chosen.plan.entries.some(e => e.reason?.includes('same destination'))).toBe(true);
    expect(a.service.resolveAll(chosen, 'local').canExecute).toBe(true);
  });
  it('shows the actual remote deletion path when an uncertain old identity was renamed remotely', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'old' }); await a.sync();
    const b = await device(remote); await b.sync();
    a.vault.files.delete('A.md'); a.vault.files.set('B.md', bytes('old')); await a.state.recordRename('A.md', 'B.md'); await a.sync();
    b.vault.files.delete('A.md'); b.vault.files.set('C.md', bytes('untracked edit'));
    const resolved = b.service.resolveAll(await b.service.preview(options, 'test'), 'local');
    expect(resolved.plan.entries.find(entry => entry.category === 'PUSH_DELETE')?.path).toBe('B.md');
    await b.service.execute(resolved, 'test'); expect(remote.contents()['B.md']).toBeUndefined(); expect(remote.text('C.md')).toBe('untracked edit');
  });
});
