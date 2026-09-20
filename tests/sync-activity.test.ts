import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoSyncController } from '../src/product/AutoSyncController';
import { ProductStore } from '../src/product/ProductStore';
import { activityIndicator } from '../src/product/SyncActivity';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { bytes, target } from './helpers';
import { GitFixture, WritableVault } from './v1-harness';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
async function setup() {
  const vault = new WritableVault({ 'note.md': 'original' }); const remote = new GitFixture();
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load(); const changed = vi.fn();
  const product = new ProductStore({ read: p => vault.readInternal(p), write: (p, s) => vault.writeInternal(p, s) }, changed);
  await product.load(state.current().deviceId, 'Activity test', 'desktop');
  const service = new SyncService(vault, r => remote.transport(r), '.obsidian', state, product);
  const sync = async () => service.execute(await service.preview(options, 'test'), 'test');
  return { vault, remote, state, product, changed, service, sync };
}
afterEach(() => vi.useRealTimers());
describe('Real sync activity projection', () => {
  it('projects required states and safe routes without IO; verified fades without advancing lifecycle', async () => {
    const a = await setup(); const cache = a.product.snapshot(); const idle = a.product.activitySnapshot();
    expect(activityIndicator({ ...cache, status: 'Healthy' }, idle).label).toBe('Healthy');
    expect(activityIndicator({ ...cache, lastChangeAt: new Date().toISOString() }, idle).label).toBe('Local changes');
    expect(activityIndicator({ ...cache, auto: { result: 'Waiting', scheduledAt: 30000 } }, idle, 1000).label).toBe('Auto sync in 29s');
    for (const status of ['Conflict', 'Recovery Required'] as const) {
      expect(activityIndicator({ ...cache, status }, idle)).toMatchObject({ label: expect.stringContaining('Review required'), destination: status === 'Conflict' ? 'preview' : 'recovery' });
    }
    expect(activityIndicator({ ...cache, auto: { result: 'Manual confirmation required' } }, idle).destination).toBe('preview');
    expect(activityIndicator(cache, { ...idle, running: true, operation: 'preview' }).label).toBe('Previewing');
    expect(activityIndicator(cache, { ...idle, running: true, stage: 'Publish' }).label).toBe('Syncing');
    expect(activityIndicator(cache, { ...idle, running: true, stage: 'Verify local' }).label).toBe('Verifying');
    expect(activityIndicator(cache, { ...idle, error: 'safe failure' }).label).toBe('Error');
    expect(activityIndicator({ ...cache, status: 'Healthy' }, { ...idle, verified: true, endedAt: 100 }, 200).label).toBe('Synced & verified');
    expect(activityIndicator({ ...cache, status: 'Healthy' }, { ...idle, verified: true, endedAt: 100 }, 5000).label).toBe('Healthy');
    expect(a.remote.calls).toEqual([]);
  });
  it.each(['manual', 'auto'])('%s exposes real stages, file counts and completion only after pointer clear', async mode => {
    const a = await setup(); await a.sync(); a.vault.files.set('note.md', bytes('new'));
    const observed: ReturnType<ProductStore['activitySnapshot']>[] = [];
    a.changed.mockImplementation(() => observed.push(a.product.activitySnapshot()));
    if (mode === 'manual') await a.sync();
    else {
      const settings = { ...DEFAULT_SETTINGS, autoSync: true };
      const auto = new AutoSyncController({ settings: () => settings, busy: () => a.service.running,
        check: async () => { const preview = await a.service.preview(options, 'test'); return { preview, block: a.service.autoBlock(preview, settings) }; },
        execute: p => a.service.execute(p, 'test'), status: s => a.product.auto(s) });
      await auto.run(); auto.stop();
    }
    const result = a.product.activitySnapshot();
    expect(result.steps.map(s => s.stage)).toEqual(expect.arrayContaining(['Scan local', 'Read remote', 'Build plan', 'Upload blobs', 'Create tree', 'Create commit', 'Publish', 'Verify remote', 'Verify local', 'Save BASE', 'Complete']));
    expect(observed.some(s => s.stage === 'Upload blobs' && s.processed === 1 && s.total === 1)).toBe(true);
    expect(observed.some(s => s.stage === 'Verify remote' && s.running)).toBe(true);
    expect(result).toMatchObject({ running: false, verified: true, generation: 2 });
    expect(await a.service.transactions.active()).toBeNull();
    expect(JSON.stringify(a.product.snapshot())).not.toContain('steps');
  });
  it('does not advance a held Publish with time or by reading activity', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    const transport = a.remote.transport; let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { reached = r; });
    a.remote.transport = async r => { if (r.method === 'PATCH') { reached(); await gate; } return transport(r); };
    const run = a.service.execute(p, 'test'); await ready;
    const requests = a.remote.calls.length; vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(120000);
    for (let i = 0; i < 10; i++) expect(a.product.activitySnapshot()).toMatchObject({ stage: 'Publish', running: true, verified: false });
    expect(a.remote.calls).toHaveLength(requests); vi.useRealTimers(); release(); await run;
  });
  it.each(['local verify', 'pointer clear'])('never reports verified after %s failure; retains stage and safe error', async where => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    if (where === 'local verify') a.remote.beforePatch = () => a.vault.files.set('note.md', bytes('concurrent'));
    else {
      const write = a.vault.writeInternal.bind(a.vault);
      vi.spyOn(a.vault, 'writeInternal').mockImplementation(async (path, value) => {
        if (path.endsWith('/active.json') && value === 'null') throw new Error('private credential');
        await write(path, value);
      });
    }
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    expect(a.product.activitySnapshot()).toMatchObject({ running: false, verified: false });
    expect(a.product.activitySnapshot().error).toBeTruthy();
    expect(a.product.activitySnapshot().error).not.toContain('private credential');
    expect(a.product.activitySnapshot().steps.some(s => s.stage === 'Complete')).toBe(false);
  });
  it('publishes a real debounce deadline, resets it on changes, and clears it on disable', async () => {
    const a = await setup(); vi.useFakeTimers(); const settings = { ...DEFAULT_SETTINGS, autoSync: true };
    const check = vi.fn();
    const auto = new AutoSyncController({ settings: () => settings, busy: () => false, check, execute: vi.fn(), status: s => a.product.auto(s) });
    auto.changed(); expect(a.product.snapshot().auto.scheduledAt).toBe(Date.now() + 30000);
    await vi.advanceTimersByTimeAsync(5000); auto.changed(); expect(a.product.snapshot().auto.scheduledAt).toBe(Date.now() + 30000);
    settings.autoSync = false; auto.configure(); expect(a.product.snapshot().auto.scheduledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60000); expect(check).not.toHaveBeenCalled(); auto.stop();
  });
  it('preserves an existing pending debounce after manual completion acknowledges review', async () => {
    const a = await setup(); await a.sync(); vi.useFakeTimers();
    const settings = { ...DEFAULT_SETTINGS, autoSync: true };
    const check = vi.fn(async () => ({ preview: await a.service.preview(options, 'test') }));
    const auto = new AutoSyncController({ settings: () => settings, busy: () => false, check, execute: vi.fn(), status: s => a.product.auto(s) });
    auto.changed(); const deadline = a.product.snapshot().auto.scheduledAt; auto.reviewed();
    expect(a.product.snapshot().auto.scheduledAt).toBe(deadline);
    await vi.advanceTimersByTimeAsync(30000); expect(check).toHaveBeenCalledOnce(); auto.stop();
  });
  it('does not persist or revive running activity/debounce after reload', async () => {
    const a = await setup(); await a.product.auto({ result: 'Waiting for Auto Sync', scheduledAt: Date.now() + 30000 });
    expect(a.vault.internal.get('product-state.json')).not.toContain('scheduledAt');
    await a.product.load(a.state.current().deviceId, 'Reload', 'mobile');
    expect(a.product.snapshot().auto.scheduledAt).toBeUndefined();
    expect(a.product.activitySnapshot()).toMatchObject({ running: false, steps: [] });
  });
  it('reports reliable scan/local verify counts and allows identity tracking during read-only Preview', async () => {
    const a = await setup(); const seen: ReturnType<ProductStore['activitySnapshot']>[] = [];
    a.changed.mockImplementation(() => {
      const snapshot = a.product.activitySnapshot(); seen.push(snapshot);
      if (snapshot.operation === 'preview') expect(a.service.executing).toBe(false);
    });
    await a.sync();
    for (const stage of ['Scan local', 'Verify local']) expect(seen.some(s => s.stage === stage && s.processed === 1 && s.total === 1)).toBe(true);
  });
  it('retains recovery stage metadata on Resume and never invents a skipped local Verify', async () => {
    const a = await setup(); const p = await a.service.preview(options, 'test');
    a.remote.beforePatch = () => a.vault.files.set('note.md', bytes('later edit'));
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    const t = (await a.service.transactions.active())!;
    await a.service.resume(options, 'test');
    expect(a.product.activitySnapshot()).toMatchObject({ transactionId: t.id, generation: 1, verified: true, running: false });
    expect(a.product.activitySnapshot().steps.some(s => s.stage === 'Verify local')).toBe(false);
  });
});
