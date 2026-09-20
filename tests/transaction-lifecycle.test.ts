import { describe, expect, it, vi } from 'vitest';
import { AutoSyncController } from '../src/product/AutoSyncController';
import { ProductStore } from '../src/product/ProductStore';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { bytes, target } from './helpers';
import { GitFixture, WritableVault } from './v1-harness';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
async function setup(remote = new GitFixture(), files: Record<string, string> = { 'note.md': 'original' }) {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const changed = vi.fn();
  const product = new ProductStore({ read: p => vault.readInternal(p), write: (p, s) => vault.writeInternal(p, s) }, changed);
  await product.load(state.current().deviceId, 'Lifecycle test', 'desktop');
  const service = new SyncService(vault, r => remote.transport(r), '.obsidian', state, product);
  const sync = async () => service.execute(await service.preview(options, 'test'), 'test');
  return { remote, vault, state, product, service, sync, changed };
}
function journals(vault: WritableVault) {
  return [...vault.internal].filter(([p]) => p.endsWith('/journal.json')).map(([, s]) => JSON.parse(JSON.parse(s).payload));
}

describe('One confirmation completes the transaction lifecycle', () => {
  it.each(['manual', 'auto'] as const)('%s runs publish → remote/local Verify → BASE readback → complete → clear without Resume', async mode => {
    const a = await setup(); await a.sync(); a.vault.files.set('note.md', bytes('new'));
    const trace: string[] = []; const requests = a.remote.calls.length;
    const transport = a.remote.transport;
    a.remote.transport = async r => {
      const result = await transport(r);
      if (r.method === 'PATCH') trace.push('publish');
      if (trace.includes('published') && r.method === 'GET' && r.url.includes('/blobs/')) trace.push('remote-verify');
      return result;
    };
    const save = a.service.transactions.save.bind(a.service.transactions);
    vi.spyOn(a.service.transactions, 'save').mockImplementation(async t => { await save(t); trace.push(t.phase); });
    const read = a.vault.readBinary.bind(a.vault);
    vi.spyOn(a.vault, 'readBinary').mockImplementation(async p => { const result = await read(p); if (trace.includes('published') && p === 'note.md') trace.push('local-verify'); return result; });
    const internal = a.vault.readInternal.bind(a.vault);
    vi.spyOn(a.vault, 'readInternal').mockImplementation(async p => { const result = await internal(p); if (trace.includes('verified') && p === 'state') trace.push('base-readback'); return result; });
    const clear = a.service.transactions.clear.bind(a.service.transactions);
    vi.spyOn(a.service.transactions, 'clear').mockImplementation(async () => { await clear(); trace.push('clear'); });
    const resume = vi.spyOn(a.service, 'resume');
    if (mode === 'manual') await a.sync();
    else {
      const settings = { ...DEFAULT_SETTINGS, autoSync: true };
      const auto = new AutoSyncController({ settings: () => settings, busy: () => a.service.running,
        check: async () => { const preview = await a.service.preview(options, 'test'); return { preview, block: a.service.autoBlock(preview, settings) }; },
        execute: p => a.service.execute(p, 'test'), status: s => a.product.auto(s) });
      await auto.run(); auto.stop(); expect(a.product.snapshot().auto.result).toBe('Verified');
    }
    for (const [first, second] of [['publish', 'published'], ['published', 'remote-verify'], ['remote-verify', 'local-verify'], ['local-verify', 'verified'], ['verified', 'base-readback'], ['base-readback', 'complete'], ['complete', 'clear']]) {
      expect(trace.indexOf(first!)).toBeGreaterThanOrEqual(0); expect(trace.indexOf(second!)).toBeGreaterThan(trace.indexOf(first!));
    }
    expect(a.remote.calls.slice(requests).filter(c => c.method === 'PATCH')).toHaveLength(1);
    expect(a.remote.calls.slice(requests).filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
    expect(resume).not.toHaveBeenCalled(); expect(await a.service.transactions.active()).toBeNull();
    expect(journals(a.vault).every(t => t.phase === 'complete')).toBe(true);
    await a.state.load(); expect(a.state.current().baseRemoteCommit).toBe(a.remote.head);
    expect(a.state.current().lastSeenGeneration).toBe(2); expect(await a.product.history()).toHaveLength(2);
  });

  it('completes mixed Push/Pull using the same pipeline', async () => {
    const a = await setup(); await a.sync(); const b = await setup(a.remote, {}); await b.sync();
    b.vault.files.set('remote.md', bytes('remote addition')); await b.sync();
    a.vault.files.set('local.md', bytes('local addition')); await a.sync();
    expect(a.vault.files.get('remote.md')).toEqual(bytes('remote addition'));
    expect(a.remote.text('local.md')).toBe('local addition');
    expect(await a.service.transactions.active()).toBeNull(); expect(journals(a.vault).at(-1).phase).toBe('complete');
  });

  it('notifies cached views after releasing the running lock and clearing the pointer', async () => {
    const a = await setup();
    const observed: { running: boolean; pointer: string | undefined }[] = [];
    a.changed.mockImplementation(() => observed.push({ running: a.service.running, pointer: a.vault.internal.get('.local-mirror-sync/transactions/active.json') }));
    await a.sync();
    expect(observed.some(s => s.running)).toBe(true);
    expect(observed.at(-1)).toEqual({ running: false, pointer: 'null' });
  });

  it.each(['remote verify', 'local verify', 'network', 'unload', 'state write', 'history write', 'pointer clear'] as const)('retains recovery on %s failure and resumes without republishing', async stage => {
    const a = await setup(); await a.sync(); const before = a.state.current(); const history = await a.product.history();
    a.vault.files.set('note.md', bytes('new')); const p = await a.service.preview(options, 'test');
    let published = false;
    const transport = a.remote.transport;
    a.remote.transport = async r => {
      if (published && stage === 'network') throw new Error('offline');
      const result = await transport(r);
      if (r.method === 'PATCH') { published = true; if (stage === 'unload') a.service.stop(); }
      if (published && stage === 'remote verify' && r.url.includes('/trees/')) return { status: 200, json: { invalid: true } };
      return result;
    };
    if (stage === 'local verify') a.remote.beforePatch = () => a.vault.files.set('note.md', bytes('concurrent edit'));
    const write = a.vault.writeInternal.bind(a.vault);
    const injection = vi.spyOn(a.vault, 'writeInternal').mockImplementation(async (path, value) => {
      if (published && (stage === 'state write' && path === 'state' || stage === 'history write' && path.startsWith('.sync-history/') || stage === 'pointer clear' && path.endsWith('/active.json') && value === 'null')) throw new Error('disk unavailable');
      await write(path, value);
    });
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    const t = (await a.service.transactions.active())!; expect(t).not.toBeNull();
    expect(await a.service.transactions.blob(t.id, t.after['note.md']!)).toEqual(bytes('new'));
    if (stage !== 'history write' && stage !== 'pointer clear') {
      expect(JSON.parse(a.vault.internal.get('state')!)).toEqual(before);
      expect(await a.product.history()).toEqual(history);
    }
    a.remote.transport = transport; injection.mockRestore(); await a.state.load();
    const requests = a.remote.calls.length;
    const restarted = new SyncService(a.vault, a.remote.transport, '.obsidian', a.state, a.product);
    await restarted.resume(options, 'test');
    expect(await restarted.transactions.active()).toBeNull(); expect(journals(a.vault).at(-1).phase).toBe('complete');
    expect(a.state.current().baseRemoteCommit).toBe(t.commit); expect(await a.product.history()).toHaveLength(2);
    expect(a.remote.calls.slice(requests).every(c => c.method === 'GET')).toBe(true);
    if (stage === 'local verify') expect(a.vault.files.get('note.md')).toEqual(bytes('concurrent edit'));
  });

  it.each(['BASE readback', 'history', 'complete checkpoint'] as const)('does not clear recovery if Obsidian closes during %s', async stage => {
    const a = await setup();
    const write = a.vault.writeInternal.bind(a.vault);
    vi.spyOn(a.vault, 'writeInternal').mockImplementation(async (path, value) => {
      await write(path, value);
      if (stage === 'BASE readback' && path === 'state' || stage === 'history' && path === '.sync-history/index.json'
        || stage === 'complete checkpoint' && path.endsWith('/journal-copy.json') && JSON.parse(JSON.parse(value).payload).phase === 'complete') a.service.stop();
    });
    await expect(a.sync()).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
    expect(await a.service.transactions.active()).not.toBeNull();
    const restarted = new SyncService(a.vault, a.remote.transport, '.obsidian', a.state, a.product);
    await restarted.resume(options, 'test'); expect(await restarted.transactions.active()).toBeNull();
    expect(await a.product.history()).toHaveLength(1);
  });

  it.each(['publish', 'remote verification'] as const)('does not overwrite device metadata changed during %s IO', async stage => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    const transport = a.remote.transport; let published = false; let changed = false;
    a.remote.transport = async r => {
      const result = await transport(r);
      if (!changed && (stage === 'publish' && r.method === 'PATCH' || stage === 'remote verification' && published && r.url.includes('/trees/'))) {
        changed = true; await a.state.save({ ...a.state.current(), syncScope: 'changed environment' });
      }
      if (r.method === 'PATCH') published = true;
      return result;
    };
    await expect(a.service.execute(p, 'test')).rejects.toMatchObject({ code: 'RECOVERY_ENV_CHANGED' });
    expect(a.state.current().baseManifest).toBeUndefined(); expect(a.state.current().syncScope).toBe('changed environment');
    expect(await a.service.transactions.active()).not.toBeNull(); expect(await a.product.history()).toEqual([]);
  });
});
