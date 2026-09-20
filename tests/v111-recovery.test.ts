import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
const pointer = '.local-mirror-sync/transactions/active.json';
async function fixture(stage = 'blobs', adoption = false) {
  const remote = new GitFixture(adoption ? { 'remote.md': 'remote' } : {});
  const vault = new WritableVault({ 'local.md': 'local' });
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  let fail = true;
  const service = new SyncService(vault, async req => fail && req.method !== 'GET' && req.url.endsWith('/' + stage)
    ? { status: 403, json: {} } : remote.transport(req), '.obsidian', state);
  let preview = await service.preview(options, 'test');
  if (adoption) preview = service.selectAdoption(preview, 'remote');
  await expect(service.execute(preview, 'test', () => {}, undefined, adoption ? 'USE REMOTE' : '')).rejects.toThrow();
  fail = false;
  return { remote, vault, state, service, preview };
}

describe('V1.1.1 Recovery safety', () => {
  it('prepared transaction can abort, removing pending metadata and retaining every backup', async () => {
    const a = await fixture('blobs', true); const t = (await a.service.transactions.active())!;
    const backups = new Map([...a.vault.internal].filter(([p]) => p !== pointer));
    const refs = new Map(a.remote.refs); const files = new Map(a.vault.files); const state = structuredClone(a.state.current());
    await a.service.abortTransaction(options, 'test');
    expect(await a.service.transactions.active()).toBeNull(); expect(await a.vault.readInternal(pointer)).toBeNull();
    expect(a.vault.internal).toEqual(backups); expect(a.remote.refs).toEqual(refs);
    expect(a.vault.files).toEqual(files); expect(a.vault.mutations).toEqual([]); expect(a.state.current()).toEqual(state);
    expect(refs.get(t.backupRef!)).toBe(t.originalHead);
  });
  it.each(['published', 'applying', 'verified', 'complete'] as const)('%s transaction cannot abort', async phase => {
    const a = await fixture(); const t = (await a.service.transactions.active())!; t.phase = phase; await a.service.transactions.save(t);
    const stored = new Map(a.vault.internal); const count = a.remote.calls.length;
    await expect(a.service.abortTransaction(options, 'test')).rejects.toThrow();
    expect(a.vault.internal).toEqual(stored); expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true);
  });
  it.each(['blobs', 'refs/heads/main'])('abort rejects changed main after failure at %s', async stage => {
    const a = await fixture(stage); a.remote.external({ 'other.md': 'new remote work' });
    const stored = new Map(a.vault.internal); const head = a.remote.head;
    await expect(a.service.abortTransaction(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(a.vault.internal).toEqual(stored); expect(a.remote.head).toBe(head);
  });
  it('abort never modifies GitHub main and always reads its current HEAD', async () => {
    const a = await fixture(); const head = a.remote.head; const count = a.remote.calls.length;
    await a.service.abortTransaction(options, 'test');
    const calls = a.remote.calls.slice(count);
    expect(calls.some(c => c.resource === 'ref/heads/main')).toBe(true);
    expect(calls.every(c => c.method === 'GET')).toBe(true); expect(a.remote.head).toBe(head);
  });
  it('abort fails closed when HEAD cannot be read', async () => {
    const a = await fixture(); a.remote.transport = async () => { throw new Error('offline'); };
    await expect(a.service.abortTransaction(options, 'test')).rejects.toThrow();
    expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('recovery blocks new Preview and execution before remote requests', async () => {
    const a = await fixture(); const count = a.remote.calls.length;
    await expect(a.service.preview(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(a.service.execute(a.preview, 'test')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(a.remote.calls).toHaveLength(count);
  });
  it('abort clears sync block and a fresh Preview can sync', async () => {
    const a = await fixture(); await a.service.abortTransaction(options, 'test');
    const p = await a.service.preview(options, 'test'); await a.service.execute(p, 'test');
    expect(a.state.current().baseManifest?.generation).toBe(1); expect(a.remote.text('local.md')).toBe('local');
  });
  it('resume after valid recovery revalidates HEAD and backup before publication', async () => {
    const a = await fixture('refs/heads/main', true); const t = (await a.service.transactions.active())!;
    const count = a.remote.calls.length; await a.service.resume(options, 'test');
    const calls = a.remote.calls.slice(count); const publish = calls.findIndex(c => c.method === 'PATCH');
    expect(calls.slice(0, publish).some(c => c.resource === 'ref/heads/main')).toBe(true);
    expect(calls.slice(0, publish).some(c => c.resource.includes('local-mirror-sync-backup/'))).toBe(true);
    expect(a.state.current().baseManifest?.generation).toBe(1); expect(a.remote.head).toBe(t.commit);
    expect(await a.service.transactions.active()).toBeNull(); expect(a.vault.files.get('remote.md')).toEqual(bytes('remote'));
  });
  it.each(['missing', 'changed'])('resume rejects %s backup before any mutation', async mode => {
    const a = await fixture('refs/heads/main', true); const t = (await a.service.transactions.active())!;
    if (mode === 'missing') a.remote.refs.delete(t.backupRef!); else a.remote.refs.set(t.backupRef!, t.commit);
    const count = a.remote.calls.length; const stored = new Map(a.vault.internal);
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true); expect(a.vault.internal).toEqual(stored); expect(a.vault.mutations).toEqual([]);
  });
  it('resume keeps an unbuilt transaction blocked when HEAD changed', async () => {
    const a = await fixture(); a.remote.external({ 'other.md': 'remote change' });
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(await a.service.transactions.active()).not.toBeNull(); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('resume never republishes a transaction marked published after remote rollback', async () => {
    const a = await fixture('refs/heads/main'); const t = (await a.service.transactions.active())!;
    t.phase = 'published'; await a.service.transactions.save(t); const count = a.remote.calls.length;
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true); expect(a.remote.head).toBe(t.originalHead);
  });
  it('resume reports an environment change if HEAD changes during backup validation', async () => {
    const a = await fixture('refs/heads/main', true); const transport = a.remote.transport; let changed = false;
    a.remote.transport = async req => {
      const response = await transport(req);
      if (!changed && req.method === 'GET' && req.url.includes('/ref/heads/local-mirror-sync-backup/')) {
        changed = true; a.remote.external({ 'other.md': 'concurrent remote work' });
      }
      return response;
    };
    const count = a.remote.calls.length;
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true);
    expect(a.vault.mutations).toEqual([]); expect(await a.service.transactions.active()).not.toBeNull();
  });
  it.each(['abort', 'resume'])('%s rechecks phase after remote validation', async operation => {
    const a = await fixture('refs/heads/main'); const t = (await a.service.transactions.active())!;
    const transport = a.remote.transport; let changed = false;
    a.remote.transport = async req => {
      const result = await transport(req);
      if (!changed && req.url.endsWith('/ref/heads/main')) { changed = true; t.phase = 'published'; await a.service.transactions.save(t); }
      return result;
    };
    const count = a.remote.calls.length;
    await expect(operation === 'abort' ? a.service.abortTransaction(options, 'test') : a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true); expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('records actual transaction creation time without requiring it for legacy journals', async () => {
    const before = Date.now(); const a = await fixture(); const t = (await a.service.transactions.active())!;
    expect(Date.parse(t.createdAt!)).toBeGreaterThanOrEqual(before); expect(Date.parse(t.createdAt!)).toBeLessThanOrEqual(Date.now());
    delete t.createdAt; await a.service.transactions.save(t); expect(await a.service.transactions.active()).not.toBeNull();
  });
});
