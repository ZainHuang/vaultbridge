import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import { bytes, target } from './helpers';
import { GitFixture, WritableVault } from './v1-harness';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
const oldPath = '02_工作空间/30 营销域/设计平台/AI听记/会议.md';
const newPath = '02_工作空间/20 电商设计平台/会议纪要/AI听记/会议.md';
async function device(remote = new GitFixture(), files = { [oldPath]: 'meeting', 'update.md': 'original', 'delete.md': 'delete' }) {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const service = new SyncService(vault, r => remote.transport(r), '.obsidian', state);
  const sync = async () => service.execute(await service.preview(options, 'test'), 'test');
  return { remote, vault, state, service, sync };
}

describe('Published Push BASE recovery preserves subsequent Local changes', () => {
  it('finishes the published snapshot and exposes directory moves, updates and additions in the next Preview', async () => {
    const a = await device(); const before = a.state.current();
    a.remote.beforePatch = () => {
      a.vault.files.set(newPath, a.vault.files.get(oldPath)!); a.vault.files.delete(oldPath);
      a.vault.files.set('update.md', bytes('later edit'));
      a.vault.files.set('added.md', bytes('later addition'));
    };
    await expect(a.sync()).rejects.toMatchObject({ code: 'LOCAL_VERIFY_FAILED' });
    const t = (await a.service.transactions.active())!; const local = [...a.vault.files];
    expect(t.phase).toBe('published'); expect(a.state.current()).toEqual(before);
    const callCount = a.remote.calls.length; const apply = vi.spyOn(a.vault, 'apply');
    await a.service.resume(options, 'test', undefined, t);
    expect(a.state.current().baseManifest).toEqual(t.manifest);
    expect(a.state.current().baseRemoteCommit).toBe(t.commit);
    expect(a.state.current().lastSeenGeneration).toBe(t.manifest.generation);
    expect([...a.vault.files]).toEqual(local); expect(apply).not.toHaveBeenCalled();
    expect(await a.service.transactions.active()).toBeNull();
    const p = await a.service.preview(options, 'test');
    expect(p.mode).toBe('SYNC'); expect(p.canExecute).toBe(true);
    expect(p.plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'PUSH_RENAME', path: newPath, oldPath }),
      expect.objectContaining({ category: 'PUSH_UPDATE', path: 'update.md' }),
      expect.objectContaining({ category: 'PUSH_ADD', path: 'added.md' }),
    ]));
    expect(a.remote.calls.slice(callCount).every(c => c.method === 'GET')).toBe(true);
    expect(a.remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    expect(JSON.parse(a.remote.text(MANIFEST_PATH))).toEqual(t.manifest);
  });

  it('preserves an observed rename plus edit and delete/recreate identity across BASE completion and reload', async () => {
    const a = await device(); await a.sync();
    a.vault.files.set('update.md', bytes('published edit'));
    a.remote.beforePatch = () => a.vault.files.set('update.md', bytes('subsequent edit'));
    await expect(a.sync()).rejects.toThrow();
    const t = (await a.service.transactions.active())!;
    const movedId = Object.values(t.manifest.files).find(f => f.path === oldPath)!.fileId;
    a.vault.files.delete(oldPath); a.vault.files.set(newPath, bytes('meeting edited after move'));
    await a.state.recordRename(oldPath, newPath);
    a.vault.files.delete('delete.md'); await a.state.recordDelete('delete.md');
    a.vault.files.set('delete.md', bytes('recreated')); await a.state.recordCreate('delete.md');
    const identities = a.state.current().localFiles!;
    const calls = a.remote.calls.length;
    await a.service.resume(options, 'test'); await a.state.load();
    expect(a.state.current().localFiles![movedId]?.path).toBe(newPath);
    for (const [id, entry] of Object.entries(identities).filter(([, f]) => f.path === 'delete.md'))
      expect(a.state.current().localFiles![id]).toMatchObject({ path: entry.path, deleted: entry.deleted });
    const p = await a.service.preview(options, 'test');
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ fileId: movedId, category: 'PUSH_RENAME_AND_UPDATE', path: newPath, oldPath }));
    // Recreate ownership remains subject to the existing planner's conflict rules.
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ category: 'CONFLICT_IDENTITY_UNCERTAIN', path: 'delete.md' }));
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });

  it('allows published Use Local Adoption with a valid backup without restoring old paths', async () => {
    const a = await device(new GitFixture({ 'remote.md': 'legacy' }));
    const p = a.service.selectAdoption(await a.service.preview(options, 'test'), 'local');
    a.remote.beforePatch = () => { a.vault.files.set(newPath, a.vault.files.get(oldPath)!); a.vault.files.delete(oldPath); };
    await expect(a.service.execute(p, 'test', undefined, undefined, 'USE LOCAL')).rejects.toThrow();
    const t = (await a.service.transactions.active())!; const files = [...a.vault.files]; const calls = a.remote.calls.length;
    await a.service.resume(options, 'test');
    expect(a.state.current().baseManifest).toEqual(t.manifest); expect([...a.vault.files]).toEqual(files);
    expect(await a.service.transactions.active()).toBeNull();
    expect(a.remote.refs.get(t.backupRef!)).toBe(t.originalHead);
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });

  it('recovers a lost publication response with later edits without a second publish', async () => {
    const a = await device(); a.remote.losePatchResponse = true;
    await expect(a.sync()).rejects.toThrow();
    a.vault.files.set('update.md', bytes('later'));
    const t = (await a.service.transactions.active())!; expect(t.phase).toBe('prepared');
    const calls = a.remote.calls.length;
    await a.service.resume(options, 'test');
    expect(a.state.current().baseRemoteCommit).toBe(t.commit);
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
    expect(a.vault.files.get('update.md')).toEqual(bytes('later'));
  });

  it('still blocks a corrupt remote published Tree and preserves BASE and Recovery', async () => {
    const a = await device(); a.remote.beforePatch = () => a.vault.files.set('update.md', bytes('later'));
    await expect(a.sync()).rejects.toThrow(); const before = a.state.current();
    const t = (await a.service.transactions.active())!;
    a.remote.contents()[oldPath] = a.remote.blob(bytes('corrupt'));
    await expect(a.service.resume(options, 'test')).rejects.toThrow();
    expect(a.state.current()).toEqual(before); expect(await a.service.transactions.active()).toEqual(t);
    expect(a.vault.mutations).toEqual([]);
  });

  it.each(['missing', 'modified', 'undeleted'] as const)('does not advance BASE when published Adoption PULL is %s', async kind => {
    const a = await device(new GitFixture({ 'pull.md': 'remote' }));
    const p = a.service.selectAdoption(await a.service.preview(options, 'test'), 'remote');
    a.remote.losePatchResponse = true; await expect(a.service.execute(p, 'test', undefined, undefined, 'USE REMOTE')).rejects.toThrow();
    const before = a.state.current(); const t = (await a.service.transactions.active())!;
    const apply = a.vault.apply.bind(a.vault);
    vi.spyOn(a.vault, 'apply').mockImplementation(async (path, data, expected, recovery) => {
      if (kind === 'missing' && path === 'pull.md' || kind === 'undeleted' && path === oldPath) return;
      await apply(path, data, expected, recovery);
      if (kind === 'modified' && path === 'pull.md') a.vault.files.set(path, bytes('bad write'));
    });
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'LOCAL_VERIFY_FAILED' });
    expect(a.state.current()).toEqual(before); expect((await a.service.transactions.active())?.id).toBe(t.id);
    expect(a.remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
});
