import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { IgnoreService } from '../src/vault/IgnoreService';
import { VaultScanner } from '../src/vault/VaultScanner';
import { safeError } from '../src/errors';
import { AutoSyncController } from '../src/product/AutoSyncController';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { verifyLocal } from '../src/sync/execution/LocalVerification';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, referenceSha, target } from './helpers';

const options = { ...target, includeObsidian: true, ignorePatterns: 'ignored/**', deleteSafetyThreshold: 20 };
const ignore = new IgnoreService({ configDir: '.obsidian', includeObsidian: true, gitignore: '', patterns: options.ignorePatterns });
const internal = ['.local-mirror-sync/transactions/new/journal.json', '.local-mirror-sync/devices/id.json', '.sync-history/new.json', '.obsidian/plugins/local-mirror-sync/device-state.json', '.obsidian/plugins/local-mirror-sync/data.json', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/cache/new', 'ignored/new.md'];
async function setup() {
  const remote = new GitFixture(); const vault = new WritableVault({ 'A.md': 'a', 'B.md': 'b' });
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const service = new SyncService(vault, remote.transport, '.obsidian', state);
  return { remote, vault, state, service };
}

describe('Local Verify domain and diagnostics', () => {
  it('reports every added/missing/modified path with exact hashes and classification, retains BASE/recovery, then resumes without republishing', async () => {
    const a = await setup(); const before = a.state.current();
    const p = await a.service.preview(options, 'test');
    a.remote.beforePatch = () => { a.vault.files.set('A.md', bytes('changed')); a.vault.files.delete('B.md'); a.vault.files.set('new.md', bytes('new')); };
    const error = await a.service.execute(p, 'test').catch(e => e);
    expect(error).toMatchObject({ code: 'LOCAL_VERIFY_FAILED', diagnostics: [
      { path: 'A.md', kind: 'modified', expectedSha: referenceSha(bytes('a')), actualSha: referenceSha(bytes('changed')), ignored: false, protected: false, internal: false },
      { path: 'B.md', kind: 'missing', expectedSha: referenceSha(bytes('b')), actualSha: null },
      { path: 'new.md', kind: 'added', expectedSha: null, actualSha: referenceSha(bytes('new')) },
    ] });
    expect(safeError(error)).toContain('A.md'); expect(safeError(error)).toContain(referenceSha(bytes('changed')));
    expect(a.state.current()).toEqual(before); expect((await a.service.transactions.active())?.phase).toBe('published');
    const local = [...a.vault.files];
    await a.service.resume(options, 'test'); expect(await a.service.transactions.active()).toBeNull();
    expect([...a.vault.files]).toEqual(local);
    expect(a.state.current().baseManifest?.generation).toBe(1);
    expect(a.remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
  it.each(internal)('ignores creation during scan of %s without reading its bytes', async path => {
    const a = await setup(); const read = a.vault.readBinary.bind(a.vault);
    vi.spyOn(a.vault, 'readBinary').mockImplementation(async p => { const b = await read(p); a.vault.files.set(path, bytes('internal update')); return b; });
    const scan = await new VaultScanner(a.vault).scan(ignore);
    expect(scan.files.map(f => f.path)).toEqual(['A.md', 'B.md']); expect(a.vault.reads).not.toContain(path);
  });
  it('allows internal/history/workspace creation after preview, after publish, and during Resume', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    for (const path of internal) a.vault.files.set(path, bytes('new'));
    a.remote.losePatchResponse = true;
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    expect(await a.service.transactions.active()).not.toBeNull();
    for (const path of internal) a.vault.files.set(path, bytes('updated'));
    await a.service.resume(options, 'test'); expect(a.state.current().baseManifest?.generation).toBe(1);
    expect(Object.values(a.state.current().baseManifest!.files).map(f => f.path).sort()).toEqual(['A.md', 'B.md']);
  });
  it('reports unreadable user path without leaking underlying errors', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    const read = a.vault.readBinary.bind(a.vault);
    a.remote.beforePatch = () => { vi.spyOn(a.vault, 'readBinary').mockImplementation(p => p === 'B.md' ? Promise.reject(new Error('secret header')) : read(p)); };
    const error = await a.service.execute(p, 'test').catch(e => e);
    expect(error).toMatchObject({ code: 'LOCAL_VERIFY_FAILED', diagnostics: [{ path: 'B.md', expectedSha: referenceSha(bytes('b')), actualSha: null, problem: 'unreadable' }] });
    expect(safeError(error)).not.toContain('secret header'); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('includes other byte differences even when one file is unreadable', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test'); const read = a.vault.readBinary.bind(a.vault);
    a.remote.beforePatch = () => {
      a.vault.files.set('A.md', bytes('changed'));
      vi.spyOn(a.vault, 'readBinary').mockImplementation(p => p === 'B.md' ? Promise.reject(new Error('unreadable')) : read(p));
    };
    const error = await a.service.execute(p, 'test').catch(e => e);
    expect(error.diagnostics.map((d: { path: string }) => d.path)).toEqual(['A.md', 'B.md']);
  });
  it('does not read a SyncPlan whole-identity excluded file, using frozen rules even if current rules changed', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    a.remote.beforePatch = () => a.vault.files.set('A.md', bytes('changed'));
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    const t = (await a.service.transactions.active())!;
    t.excludedPaths.push('excluded.md'); a.vault.files.set('excluded.md', bytes('excluded'));
    a.vault.files.set('.gitignore', bytes('A.md'));
    const read = a.vault.readBinary.bind(a.vault);
    vi.spyOn(a.vault, 'readBinary').mockImplementation(p => p === 'excluded.md' ? Promise.reject(new Error('must not read')) : read(p));
    const error = await verifyLocal(a.vault, t).catch(e => e);
    expect(error.diagnostics.some((d: { path: string }) => d.path === 'A.md')).toBe(true);
    expect(error.diagnostics.some((d: { path: string }) => d.path === 'excluded.md')).toBe(false);
  });
  it('reports a user file added during verification inventory', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test'); const read = a.vault.readBinary.bind(a.vault);
    a.remote.beforePatch = () => { vi.spyOn(a.vault, 'readBinary').mockImplementation(async p => { const b = await read(p); a.vault.files.set('new.md', bytes('new')); return b; }); };
    const error = await a.service.execute(p, 'test').catch(e => e);
    expect(error).toMatchObject({ code: 'LOCAL_VERIFY_FAILED', diagnostics: [expect.objectContaining({ path: 'new.md', kind: 'added', actualSha: referenceSha(bytes('new')) })] });
    expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('does not start Auto Sync or publish another transaction while Recovery is pending', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    a.remote.beforePatch = () => a.vault.files.set('A.md', bytes('changed'));
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    const pending = await a.service.transactions.active(); const calls = a.remote.calls.length;
    const execute = vi.fn(); const status = vi.fn();
    const auto = new AutoSyncController({ settings: () => ({ ...DEFAULT_SETTINGS, autoSync: true }), busy: () => false,
      check: async () => ({ preview: await a.service.preview(options, 'test') }), execute, status });
    await auto.run(); auto.stop(); expect(execute).not.toHaveBeenCalled(); expect(a.remote.calls).toHaveLength(calls);
    expect(await a.service.transactions.active()).toEqual(pending); expect(status.mock.calls.at(-1)?.[0].reason).toContain('RECOVERY_REQUIRED');
  });
});
