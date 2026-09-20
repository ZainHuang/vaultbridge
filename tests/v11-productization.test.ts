import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoSyncController } from '../src/product/AutoSyncController';
import { ProductStore, dashboardState } from '../src/product/ProductStore';
import { DEFAULT_SETTINGS, loadSettings } from '../src/settings/settings';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { IgnoreService } from '../src/vault/IgnoreService';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
async function setup(remote = new GitFixture(), files: Record<string, string> = { 'A.md': 'a' }, name = 'Windows-PC') {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const storage = { read: (p: string) => vault.readInternal(p), write: (p: string, s: string) => vault.writeInternal(p, s) };
  const product = new ProductStore(storage);
  await product.load(state.current().deviceId, name, 'desktop');
  const service = new SyncService(vault, remote.transport, '.obsidian', state, product);
  const preview = () => service.preview(options, 'test');
  const sync = async () => service.execute(await preview(), 'test');
  const settings = { ...DEFAULT_SETTINGS, autoSync: true };
  const statuses: string[] = [];
  const auto = new AutoSyncController({
    settings: () => settings, busy: () => service.running,
    check: async () => { const p = await preview(); return { preview: p, block: service.autoBlock(p, settings) }; },
    execute: p => service.execute(p, 'test'),
    status: s => { statuses.push(s.result); },
  });
  return { remote, vault, state, product, storage, service, preview, sync, auto, settings, statuses };
}
afterEach(() => vi.useRealTimers());

describe('V1.1 safe automatic sync', () => {
  it('defaults OFF with 30 second debounce, 5 deletes and 20 changed files', () => {
    expect(loadSettings({})).toMatchObject({ autoSync: false, autoSyncDebounceSeconds: 30, autoSyncDeleteThreshold: 5, autoSyncChangeThreshold: 20 });
    expect(loadSettings({ autoSync: 'true', autoSyncDebounceSeconds: 0, autoSyncDeleteThreshold: -1, autoSyncChangeThreshold: NaN })).toMatchObject({ autoSync: false, autoSyncDebounceSeconds: 30, autoSyncDeleteThreshold: 5, autoSyncChangeThreshold: 20 });
  });
  it('disabled auto sync never scans or sends requests', async () => {
    const a = await setup(); a.settings.autoSync = false;
    vi.useFakeTimers(); a.auto.changed(); await vi.advanceTimersByTimeAsync(60000); await a.auto.run();
    expect(a.remote.calls).toEqual([]); a.auto.stop();
  });
  it('debounces a burst into one verified sync using the real executor', async () => {
    const a = await setup(); await a.sync(); const generation = a.state.current().lastSeenGeneration!;
    vi.useFakeTimers(); a.vault.files.set('A.md', bytes('edited'));
    for (let i = 0; i < 20; i++) a.auto.changed();
    const count = a.remote.calls.length; await vi.advanceTimersByTimeAsync(29999); expect(a.remote.calls).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.remote.text('A.md')).toBe('edited'); expect(a.state.current().lastSeenGeneration).toBe(generation + 1);
    expect(a.statuses.filter(s => s === 'Verified')).toHaveLength(1); a.auto.stop();
  });
  it('safe attachment and Markdown additions sync and verify', async () => {
    const a = await setup(); await a.sync(); a.vault.files.set('B.md', bytes('new')); a.vault.files.set('image.png', new Uint8Array([0, 255]));
    await a.auto.run(); expect(a.statuses.at(-1)).toBe('Verified'); expect(a.remote.contents()['image.png']).toBeDefined();
  });
  it('delete threshold blocks and latches until explicit manual completion', async () => {
    const a = await setup(undefined, Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`${n}.md`, String(n)])));
    await a.sync(); for (let n = 0; n < 6; n++) a.vault.files.delete(`${n}.md`);
    const head = a.remote.head; await a.auto.run(); expect(a.remote.head).toBe(head); expect(a.statuses.at(-1)).toBe('Manual confirmation required');
    a.vault.files.set('0.md', bytes('0')); const calls = a.remote.calls.length; await a.auto.run(); expect(a.remote.calls).toHaveLength(calls);
    a.auto.reviewed(); await a.auto.run(); expect(a.statuses.at(-1)).toBe('Verified');
  });
  it('changed file threshold blocks more than 20 files', async () => {
    const a = await setup(); await a.sync(); for (let n = 0; n < 21; n++) a.vault.files.set(`${n}.md`, bytes('new'));
    const head = a.remote.head; await a.auto.run(); expect(a.remote.head).toBe(head); expect(a.statuses.at(-1)).toBe('Manual confirmation required');
  });
  it('conflict blocks without resolving a side', async () => {
    const a = await setup(); await a.sync(); const b = await setup(a.remote, {}); await b.sync();
    b.vault.files.set('A.md', bytes('b')); await b.sync(); a.vault.files.set('A.md', bytes('a changed'));
    const head = a.remote.head; await a.auto.run(); expect(a.remote.head).toBe(head); expect(a.statuses.at(-1)).toBe('Manual confirmation required');
  });
  it.each(['INITIALIZE', 'ADOPT', 'BOOTSTRAP'])('%s requires manual confirmation', async mode => {
    const remote = new GitFixture(mode === 'ADOPT' ? { 'R.md': 'r' } : {});
    if (mode === 'BOOTSTRAP') { const b = await setup(remote); await b.sync(); }
    const a = await setup(remote, mode === 'BOOTSTRAP' ? {} : { 'A.md': 'a' });
    await a.auto.run(); expect(a.statuses.at(-1)).toBe('Manual confirmation required'); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('remote Manifest changes require manual review even without conflicts', async () => {
    const a = await setup(); await a.sync(); const b = await setup(a.remote, {}); await b.sync(); b.vault.files.set('B.md', bytes('b')); await b.sync();
    const head = a.remote.head; await a.auto.run(); expect(a.remote.head).toBe(head); expect(a.vault.files.has('B.md')).toBe(false);
    expect(a.statuses.at(-1)).toBe('Manual confirmation required');
  });
  it('BASE changes after preview are rejected before mutation', async () => {
    const a = await setup(); await a.sync(); a.vault.files.set('A.md', bytes('new')); const p = await a.preview();
    await a.state.save({ ...a.state.current(), lastSuccessfulSyncAt: '2026-09-19T00:00:00.000Z' });
    expect(a.service.autoBlock(p, a.settings)).toMatch(/BASE|state|metadata/i);
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
  });
  it('remote changed after preview cannot be auto executed', async () => {
    const a = await setup(); await a.sync(); a.vault.files.set('A.md', bytes('new')); const p = await a.preview();
    a.remote.external({ 'external.md': 'keep' }); const head = a.remote.head;
    const c = new AutoSyncController({ settings: () => a.settings, busy: () => false, check: async () => ({ preview: p }), execute: p => a.service.execute(p, 'test'), status: s => a.statuses.push(s.result) });
    await c.run(); expect(a.remote.head).toBe(head); expect(a.statuses.at(-1)).toBe('Manual confirmation required');
  });
  it('verify failure preserves recovery, creates no success history, and blocks the next run', async () => {
    const a = await setup(); await a.sync(); const before = await a.product.history(); const base = a.state.current().baseManifest;
    a.vault.files.set('A.md', bytes('new'));
    a.remote.beforePatch = () => { a.vault.files.set('concurrent.md', bytes('keep')); };
    await a.auto.run(); expect(await a.service.transactions.active()).not.toBeNull(); expect(a.state.current().baseManifest).toEqual(base);
    expect(await a.product.history()).toEqual(before); await a.auto.run(); expect(a.statuses.at(-1)).toBe('Manual confirmation required');
  });
  it('cancelled debounce and unload never scan', async () => {
    const a = await setup(); vi.useFakeTimers(); a.auto.changed(); a.auto.stop(); await vi.advanceTimersByTimeAsync(60000); expect(a.remote.calls).toEqual([]);
  });
  it('no-op checks make no commits or success histories', async () => {
    const a = await setup(); await a.sync(); const head = a.remote.head; const history = await a.product.history(); await a.auto.run();
    expect(a.remote.head).toBe(head); expect(await a.product.history()).toEqual(history); expect(a.statuses.at(-1)).toBe('Up to date');
  });
  it('never bypasses the existing stricter delete confirmation', async () => {
    const a = await setup(); await a.sync(); a.vault.files.delete('A.md');
    const p = await a.service.preview({ ...options, deleteSafetyThreshold: 0 }, 'test'); expect(a.service.autoBlock(p, a.settings)).toBeTruthy();
  });
  it('restores manual confirmation latch across plugin restart', async () => {
    const a = await setup(); let checks = 0;
    const c = new AutoSyncController({ settings: () => a.settings, busy: () => false, check: async () => { checks++; return { preview: await a.preview() }; }, execute: p => a.service.execute(p, 'test'), status: () => {} }, { result: 'Manual confirmation required', reason: 'Delete threshold' });
    await c.run(); expect(checks).toBe(0); c.stop();
  });
  it('stops before execution if Auto Sync is disabled during Preview', async () => {
    const a = await setup(); await a.sync(); a.vault.files.set('A.md', bytes('edited')); const head = a.remote.head;
    const c = new AutoSyncController({ settings: () => a.settings, busy: () => false, check: async () => { const p = await a.preview(); a.settings.autoSync = false; return { preview: p }; }, execute: p => a.service.execute(p, 'test'), status: () => {} });
    await c.run(); expect(a.remote.head).toBe(head);
  });
  it('pending recovery blocks before any GitHub request', async () => {
    const a = await setup(); a.remote.losePatchResponse = true; await expect(a.sync()).rejects.toThrow(); const calls = a.remote.calls.length;
    await a.auto.run(); expect(a.remote.calls).toHaveLength(calls); expect(a.statuses.at(-1)).toBe('Manual confirmation required');
  });
  it('serializes checks and coalesces changes arriving while busy', async () => {
    const a = await setup(); await a.sync(); let release!: () => void; let checks = 0;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const c = new AutoSyncController({ settings: () => a.settings, busy: () => false, check: async () => { checks++; await wait; return { preview: await a.preview() }; }, execute: p => a.service.execute(p, 'test'), status: () => {} });
    vi.useFakeTimers(); const first = c.run(); await Promise.resolve(); await c.run(); c.changed(); expect(checks).toBe(1);
    release(); await first; await vi.advanceTimersByTimeAsync(30000); expect(checks).toBe(2); c.stop();
  });
});

describe('V1.1 local history and devices', () => {
  it('successful Sync + Verify writes a local-only complete history record', async () => {
    const a = await setup(); await a.sync(); const history = await a.product.history();
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ deviceId: a.state.current().deviceId, generationBefore: 0, generationAfter: 1, commitSha: a.remote.head, addCount: 1, updateCount: 0, deleteCount: 0, renameCount: 0, verifyResult: 'PASS' });
    expect([...a.vault.internal.keys()].some(p => /^\.sync-history\/history-\d{8}-\d{6}.*\.json$/.test(p))).toBe(true);
    expect(Object.keys(a.remote.contents()).some(p => p.startsWith('.sync-history/'))).toBe(false);
    expect(Object.values(a.state.current().baseManifest!.files).some(f => f.path.startsWith('.sync-history/'))).toBe(false);
  });
  it('history survives recovery after a lost publish response without duplicate records', async () => {
    const a = await setup(); await a.sync(); const before = await a.product.history(); a.vault.files.set('A.md', bytes('new')); a.remote.losePatchResponse = true;
    await expect(a.sync()).rejects.toThrow(); expect(await a.product.history()).toEqual(before);
    await a.service.resume(options, 'test'); expect(await a.product.history()).toHaveLength(2); expect((await a.product.history())[0]?.updateCount).toBe(1);
    expect(await a.service.transactions.active()).toBeNull();
  });
  it('history write failure retains journal and retries idempotently', async () => {
    const a = await setup(); const write = a.storage.write; let fail = true;
    a.storage.write = async (p, s) => { if (fail && p === '.sync-history/index.json') throw new Error('disk full'); return write(p, s); };
    await expect(a.sync()).rejects.toThrow(); expect(await a.service.transactions.active()).not.toBeNull();
    fail = false; await a.service.resume(options, 'test'); expect(await a.product.history()).toHaveLength(1);
    expect([...a.vault.internal.keys()].filter(p => /history-.*json$/.test(p))).toHaveLength(1);
  });
  it('history counts rename plus edit once per kind, and real deletions separately', async () => {
    const a = await setup(); await a.sync(); a.vault.files.delete('A.md'); a.vault.files.set('B.md', bytes('edited')); await a.state.recordRename('A.md', 'B.md'); await a.sync();
    expect((await a.product.history())[0]).toMatchObject({ addCount: 0, updateCount: 1, deleteCount: 0, renameCount: 1 });
  });
  it('history collisions within a second retain each transaction', async () => {
    const a = await setup(); vi.useFakeTimers(); await a.sync(); a.vault.files.set('A.md', bytes('new')); await a.sync();
    expect(await a.product.history()).toHaveLength(2); expect(new Set((await a.product.history()).map(h => h.transactionId)).size).toBe(2);
  });
  it('creates and persists device identity, name, type and last verified sync', async () => {
    const a = await setup(); expect(a.product.snapshot().currentDevice).toMatchObject({ deviceId: a.state.current().deviceId, deviceName: 'Windows-PC', deviceType: 'desktop' });
    await a.sync(); await a.product.configure('My PC', 'desktop'); const restored = new ProductStore(a.storage); await restored.load(a.state.current().deviceId, 'My PC', 'desktop');
    expect(restored.snapshot().currentDevice).toMatchObject({ deviceName: 'My PC', lastGeneration: 1, lastSyncAt: expect.any(String) });
  });
  it('discovers multiple device reports through pinned sync reads and persists them', async () => {
    const a = await setup(); await a.sync(); const b = await setup(a.remote, {}, 'iPhone'); await b.sync(); b.vault.files.set('B.md', bytes('b')); await b.sync(); await a.preview();
    expect(a.product.snapshot().devices.map(d => d.deviceName).sort()).toEqual(['Windows-PC', 'iPhone']);
    const restored = new ProductStore(a.storage); await restored.load(a.state.current().deviceId, 'Windows-PC', 'desktop');
    expect(restored.snapshot().devices).toHaveLength(2);
  });
  it('protects history from negated ignore rules in all scopes', () => {
    const ignore = new IgnoreService({ configDir: '.custom', includeObsidian: true, gitignore: '', patterns: '!**' });
    for (const p of ['.sync-history', '.sync-history/history-20260919-163000.json', '.SYNC-HISTORY/index.json']) expect(ignore.reason(p)).toBeTruthy();
  });
  it('keeps existing history intact when an index is damaged', async () => {
    const a = await setup(); await a.sync(); const record = [...a.vault.internal].find(([p]) => /history-.*json$/.test(p))!;
    a.vault.internal.set('.sync-history/index.json', '{'); a.vault.files.set('A.md', bytes('new'));
    await expect(a.sync()).rejects.toThrow(); expect(a.vault.internal.get(record[0])).toBe(record[1]); expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('ignores malformed advisory peer reports without accepting them as sync authority', async () => {
    const a = await setup(); await a.sync(); const existing = Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)]));
    a.remote.external({ ...existing, '.local-mirror-sync/devices/invalid.json': '{' }); await a.preview();
    expect(a.product.snapshot().devices).toHaveLength(1); expect(a.product.snapshot().warning).toBeTruthy();
  });
  it('device reporting follows the authoritative device identity restored by recovery', async () => {
    const a = await setup(); const id = crypto.randomUUID(); await a.state.save({ ...a.state.current(), deviceId: id }); await a.sync();
    expect(a.product.snapshot().currentDevice.deviceId).toBe(id);
    expect(JSON.parse(a.remote.text(`.local-mirror-sync/devices/${id}.json`)).deviceId).toBe(id);
  });
  it('resuming a V1 journal preserves history without inventing missing operation counts', async () => {
    const a = await setup(); a.remote.losePatchResponse = true; await expect(a.sync()).rejects.toThrow();
    const t = (await a.service.transactions.active())!; delete t.observation; await a.service.transactions.save(t);
    await a.service.resume(options, 'test'); expect(await a.product.history()).toEqual([]);
    expect(a.product.snapshot().warning).toMatch(/V1.0/); expect(a.state.current().lastSeenGeneration).toBe(1);
  });
});

describe('V1.1 cached dashboard', () => {
  it('healthy state shows verified counts and cached repository with no network reads', async () => {
    const a = await setup(); await a.sync(); const calls = a.remote.calls.length;
    const d = dashboardState(a.state.current(), a.product.snapshot(), options); expect(d.status).toBe('Healthy'); expect(d.localFiles).toBe(1); expect(d.remoteFiles).toBe(1); expect(d.generation).toBe(1);
    expect(a.remote.calls).toHaveLength(calls);
  });
  it('conflict state reflects the unresolved plan', async () => {
    const a = await setup(); await a.sync(); const b = await setup(a.remote, {}); await b.sync(); b.vault.files.set('A.md', bytes('b')); await b.sync(); a.vault.files.set('A.md', bytes('different')); await a.preview();
    expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Conflict');
  });
  it('recovery takes priority over offline and last verified state', async () => {
    const a = await setup(); await a.sync(); await a.product.failure(new Error('offline'), true);
    expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Recovery Required');
  });
  it('missing remote never displays Healthy', async () => {
    const a = await setup(); await a.sync(); await a.product.failure(new Error('offline'), false);
    expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Offline');
  });
  it('missing BASE never displays Healthy', async () => {
    const a = await setup(); expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Sync Required');
  });
  it('local changes invalidate cached health and record last change', async () => {
    const a = await setup(); await a.sync(); await a.product.dirty(); expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Sync Required'); expect(a.product.snapshot().lastChangeAt).toBeTruthy();
  });
  it('a different target cannot reuse cached counts or health', async () => {
    const a = await setup(); await a.sync(); const d = dashboardState(a.state.current(), a.product.snapshot(), { ...options, repository: 'another' });
    expect(d.status).toBe('Sync Required'); expect(d.remoteFiles).toBeUndefined();
  });
  it('a discarded unpublished recovery returns to Sync Required, not Healthy', async () => {
    const a = await setup(); await a.sync(); await a.product.failure(new Error('recovery'), true); await a.product.recoveryCleared();
    expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Sync Required');
  });
  it('upgrading from V1 preserves the known last verified time without claiming a fresh check', async () => {
    const a = await setup(); await a.sync(); a.vault.internal.delete('product-state.json');
    const product = new ProductStore(a.storage); await product.load(a.state.current().deviceId, 'Windows-PC', 'desktop');
    const d = dashboardState(a.state.current(), product.snapshot(), options);
    expect(d.lastVerifiedAt).toBe(a.state.current().lastSuccessfulSyncAt); expect(d.status).toBe('Sync Required');
  });
  it('a changed generation still requires sync even if eligible file bytes already match', async () => {
    const a = await setup(); await a.sync(); const b = await setup(a.remote, {}); await b.sync(); b.vault.files.set('B.md', bytes('b')); await b.sync();
    a.vault.files.set('B.md', bytes('b')); await a.preview();
    expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Sync Required');
  });
  it('unreadable local cache still exposes a diagnostic snapshot', async () => {
    const a = await setup(); const p = new ProductStore({ read: async () => { throw new Error('disk'); }, write: async () => {} });
    await expect(p.load(a.state.current().deviceId, 'Windows-PC', 'desktop')).rejects.toThrow();
    expect(p.snapshot().currentDevice.deviceId).toBe(a.state.current().deviceId);
  });
  it('unreachable remote before first BASE displays Offline', async () => {
    const a = await setup(); await a.product.failure(new Error('offline'), false);
    expect(dashboardState(a.state.current(), a.product.snapshot(), options).status).toBe('Offline');
  });
});
