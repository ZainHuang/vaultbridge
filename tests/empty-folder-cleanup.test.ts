import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
class DirectoryVault extends WritableVault {
  folders = new Set<string>();
  removed: string[] = [];
  failFolder?: string;
  beforeRemove?: (path: string) => void;
  override async list(parent: string) {
    const result = await super.list(parent);
    const prefix = parent ? `${parent}/` : '';
    for (const path of [...this.folders, ...this.internal.keys()]) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length);
      const folder = tail.includes('/') ? prefix + tail.split('/')[0] : this.folders.has(path) ? path : undefined;
      if (folder && !result.folders.includes(folder)) result.folders.push(folder);
    }
    return result;
  }
  async removeEmptyFolder(path: string) {
    this.beforeRemove?.(path);
    if (path === this.failFolder) throw new Error('folder removal failed');
    const entries = await this.list(path);
    if (entries.files.length || entries.folders.length || !this.folders.has(path)) return;
    this.folders.delete(path); this.removed.push(path);
  }
}
async function setup() {
  const remote = new GitFixture();
  const vault = new DirectoryVault({ 'old/nested/note.md': 'note', 'keep.md': 'keep' });
  vault.folders = new Set(['old', 'old/nested', 'intentional-empty']);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: text => vault.writeInternal('state', text) });
  await state.load();
  const service = new SyncService(vault, remote.transport, '.obsidian', state);
  const sync = async () => service.execute(await service.preview(options, 'fixture'), 'fixture');
  await sync();
  const rename = async () => {
    vault.files.set('new/note.md', bytes('note')); vault.files.delete('old/nested/note.md');
    vault.folders.add('new'); await state.recordRename('old/nested/note.md', 'new/note.md');
  };
  return { remote, vault, state, service, sync, rename };
}
describe('sync empty directory cleanup', () => {
  it('removes nested old parents after rename, preserving unrelated empty folders and file bytes', async () => {
    const { vault, sync, rename } = await setup(); await rename(); await sync();
    expect(vault.removed).toEqual(['old/nested', 'old']);
    expect(vault.folders.has('intentional-empty')).toBe(true);
    expect(vault.files.get('new/note.md')).toEqual(bytes('note'));
  });
  it('repairs old-version leftovers from completed journals even when Preview has no file changes', async () => {
    const { remote, vault, service, sync, rename } = await setup(); await rename(); await sync();
    vault.folders.add('old'); vault.folders.add('old/nested'); vault.removed = [];
    const head = remote.head;
    const preview = await service.preview(options, 'fixture');
    expect(vault.removed).toEqual([]); // Preview is read-only.
    expect(preview.plan.entries.every(e => e.category === 'UNCHANGED')).toBe(true);
    await service.execute(preview, 'fixture');
    expect(vault.removed).toEqual(['old/nested', 'old']);
    expect(remote.head).toBe(head);
  });
  it('preserves hidden files, ignored subfolders, excluded scopes and nonempty parents', async () => {
    const { vault, sync, rename, service } = await setup(); await rename();
    vault.files.set('old/nested/.hidden', bytes('private')); await sync();
    expect(vault.folders.has('old/nested')).toBe(true);
    vault.files.delete('old/nested/.hidden'); vault.folders.add('old/nested/ignored');
    await sync(); expect(vault.folders.has('old/nested')).toBe(true);
    vault.folders.delete('old/nested/ignored');
    const ignored = { ...options, ignorePatterns: 'old/' };
    await service.execute(await service.preview(ignored, 'fixture'), 'fixture');
    expect(vault.folders.has('old/nested')).toBe(true);
  });
  it('does not report success or advance BASE on cleanup failure; Resume retries it', async () => {
    const { vault, state, service, sync, rename } = await setup(); await rename();
    const generation = state.current().lastSeenGeneration;
    vault.failFolder = 'old/nested';
    await expect(sync()).rejects.toThrow('folder removal failed');
    expect(state.current().lastSeenGeneration).toBe(generation);
    expect(await service.transactions.active()).not.toBeNull();
    vault.failFolder = undefined;
    await service.resume(options, 'fixture');
    expect(vault.folders.has('old')).toBe(false);
    expect(await service.transactions.active()).toBeNull();
  });
  it('a file arriving during cleanup survives and fails file verification', async () => {
    const { vault, state, sync, rename } = await setup(); await rename();
    const generation = state.current().lastSeenGeneration;
    vault.beforeRemove = path => { if (path === 'old/nested') vault.files.set('old/nested/concurrent.md', bytes('new')); };
    await expect(sync()).rejects.toThrow();
    expect(vault.files.get('old/nested/concurrent.md')).toEqual(bytes('new'));
    expect(state.current().lastSeenGeneration).toBe(generation);
  });
  it('ignores damaged historical journals rather than treating them as cleanup authority', async () => {
    const { vault, sync, rename } = await setup(); await rename(); await sync();
    vault.folders.add('old'); vault.folders.add('old/nested'); vault.removed = [];
    for (const key of vault.internal.keys()) if (/journal(-copy)?\.json$/.test(key)) vault.internal.set(key, 'damaged');
    await sync();
    expect(vault.removed).toEqual([]);
    expect(vault.folders.has('old')).toBe(true);
  });
  it('can recover historical cleanup hints from the second verified journal copy', async () => {
    const { vault, sync, rename } = await setup(); await rename(); await sync();
    vault.folders.add('old'); vault.folders.add('old/nested'); vault.removed = [];
    for (const key of vault.internal.keys()) if (key.endsWith('/journal.json')) vault.internal.set(key, 'damaged');
    await sync(); expect(vault.removed).toEqual(['old/nested', 'old']);
  });
});
