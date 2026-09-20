import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

export const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
export async function device(remote: GitFixture, files: Record<string, string> = {}) {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const service = new SyncService(vault, remote.transport, '.obsidian', state);
  const sync = async () => {
    const preview = await service.preview(options, 'test');
    return preview.mode === 'ADOPT'
      ? service.execute(service.selectAdoption(preview, 'remote'), 'test', () => {}, undefined, 'USE REMOTE')
      : service.execute(preview, 'test');
  };
  return { vault, state, service, sync };
}
describe('V1 real executor contract', () => {
  it('initializes, bootstraps a second device, and propagates updates, rename and tombstones', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'first', '图片.png': 'binary' });
    const p = await a.service.preview(options, 'test');
    expect(p.mode).toBe('INITIALIZE'); expect(remote.calls.every(c => c.method === 'GET')).toBe(true);
    await a.service.execute(p, 'test');
    expect(a.state.current().baseManifest?.generation).toBe(1);
    const b = await device(remote); await b.sync(); expect(b.vault.files.get('A.md')).toEqual(bytes('first'));
    a.vault.files.set('A.md', bytes('edited')); await a.sync(); await b.sync(); expect(b.vault.files.get('A.md')).toEqual(bytes('edited'));
    a.vault.files.set('B.md', bytes('edited again')); a.vault.files.delete('A.md'); await a.state.recordRename('A.md', 'B.md');
    await a.sync(); await b.sync(); expect(b.vault.files.has('A.md')).toBe(false); expect(b.vault.files.get('B.md')).toEqual(bytes('edited again'));
    b.vault.files.delete('B.md'); await b.sync(); await a.sync(); expect(a.vault.files.has('B.md')).toBe(false);
    expect(Object.values(a.state.current().baseManifest!.files).some(f => f.deleted && f.path === 'B.md')).toBe(true);
    expect(remote.calls.filter(c => c.method === 'PATCH').every(c => c.body?.force === false)).toBe(true);
  });
  it('requires explicit legacy authority and still blocks divergent shared paths when attaching', async () => {
    const remote = new GitFixture({ 'R.md': 'remote', 'same.md': 'same' });
    const a = await device(remote, { 'L.md': 'local', 'same.md': 'same' }); const p = await a.service.preview(options, 'test');
    expect(p.mode).toBe('ADOPT'); expect(p.plan.counts.PUSH_DELETE + p.plan.counts.PULL_DELETE).toBe(0);
    await expect(a.service.execute(p, 'test')).rejects.toThrow();
    await a.service.execute(a.service.selectAdoption(p, 'local'), 'test', () => {}, undefined, 'USE LOCAL');
    expect(remote.text('L.md')).toBe('local'); expect(remote.contents()['R.md']).toBeUndefined();
    const b = await device(remote, { 'same.md': 'different' }); const conflict = await b.service.preview(options, 'test');
    expect(conflict.plan.hasConflicts).toBe(true); await expect(b.service.execute(conflict, 'test')).rejects.toThrow();
    expect(b.state.current().baseManifest).toBeUndefined();
  });
  it('rejects a stale local preview before publishing or touching notes', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); const p = await a.service.preview(options, 'test');
    a.vault.files.set('A.md', bytes('new')); await expect(a.service.execute(p, 'test')).rejects.toThrow();
    expect(remote.calls.some(c => c.method !== 'GET')).toBe(false); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('fails a competing GitHub writer without overwriting its commit', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); const p = await a.service.preview(options, 'test');
    remote.beforePatch = () => remote.external({ 'other.md': 'concurrent' });
    await expect(a.service.execute(p, 'test')).rejects.toThrow(); expect(remote.text('other.md')).toBe('concurrent');
    expect(a.state.current().baseManifest).toBeUndefined(); expect(a.vault.mutations).toEqual([]);
  });
  it('recovers a lost publish response and a restarted local apply without advancing BASE early', async () => {
    const remote = new GitFixture({ 'R.md': 'remote' }); const a = await device(remote, { 'L.md': 'local' });
    remote.losePatchResponse = true; await expect(a.sync()).rejects.toThrow(); expect(a.state.current().baseManifest).toBeUndefined();
    a.vault.failPath = 'R.md'; await expect(a.service.resume(options, 'test')).rejects.toThrow(); expect(a.state.current().baseManifest).toBeUndefined();
    a.vault.failPath = undefined; const restarted = new SyncService(a.vault, remote.transport, '.obsidian', a.state);
    await restarted.resume(options, 'test'); expect(a.vault.files.get('R.md')).toEqual(bytes('remote')); expect(a.state.current().baseManifest?.generation).toBe(1);
    expect(remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
  });
  it('blocks concurrent content changes; explicit per-file resolution is reviewable', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync(); const b = await device(remote); await b.sync();
    a.vault.files.set('A.md', bytes('from A')); b.vault.files.set('A.md', bytes('from B')); await a.sync();
    const p = await b.service.preview(options, 'test'); expect(p.plan.hasConflicts).toBe(true);
    await expect(b.service.execute(p, 'test')).rejects.toThrow();
    const resolved = await b.service.preview(options, 'test', () => {}, undefined, { [p.plan.entries[0]!.fileId!]: 'remote' });
    expect(resolved.plan.hasConflicts).toBe(false); await b.service.execute(resolved, 'test'); expect(b.vault.files.get('A.md')).toEqual(bytes('from A'));
  });
  it('preserves ignored and protected bytes on both sides even during adoption', async () => {
    const remote = new GitFixture({ 'note.md': 'remote', 'skip.log': 'remote ignored', '.obsidian/plugins/local-mirror-sync/data.json': 'remote secret' });
    const a = await device(remote, { 'skip.log': 'local ignored', '.obsidian/plugins/local-mirror-sync/data.json': 'local secret' });
    const p = await a.service.preview({ ...options, ignorePatterns: '*.log' }, 'test');
    await a.service.execute(a.service.selectAdoption(p, 'remote'), 'test', () => {}, undefined, 'USE REMOTE');
    expect(remote.text('skip.log')).toBe('remote ignored'); expect(a.vault.files.get('skip.log')).toEqual(bytes('local ignored'));
    expect(remote.text('.obsidian/plugins/local-mirror-sync/data.json')).toBe('remote secret');
    expect(a.vault.mutations).toEqual(['note.md']);
  });
  it('requires an explicit new union when ignore scope changes', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync();
    const b = await device(remote); await b.sync(); b.vault.files.set('private.md', bytes('b')); await b.sync();
    const hidden = { ...options, ignorePatterns: 'private.md' };
    await a.service.execute(await a.service.preview(hidden, 'test'), 'test'); expect(a.vault.files.has('private.md')).toBe(false);
    const p = await a.service.preview(options, 'test'); expect(p.mode).toBe('SCOPE_REVIEW'); expect(p.plan.counts.PUSH_DELETE).toBe(0);
    await a.service.execute(p, 'test'); expect(a.vault.files.get('private.md')).toEqual(bytes('b'));
  });
  it('requires the exact large deletion acknowledgement', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync(); a.vault.files.delete('A.md');
    const p = await a.service.preview({ ...options, deleteSafetyThreshold: 0 }, 'test');
    await expect(a.service.execute(p, 'test')).rejects.toThrow('DELETE 1'); expect(remote.text('A.md')).toBe('a');
    await a.service.execute(p, 'test', () => {}, undefined, 'DELETE 1'); expect(remote.contents()['A.md']).toBeUndefined();
  });
  it('creates a new identity after a recorded delete/create instead of resurrecting a tombstone', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync();
    a.vault.files.delete('A.md'); await a.state.recordDelete('A.md'); await a.sync();
    a.vault.files.set('A.md', bytes('recreated')); await a.state.recordCreate('A.md'); const p = await a.service.preview(options, 'test');
    expect(p.plan.hasConflicts).toBe(false); await a.service.execute(p, 'test');
    const files = Object.values(a.state.current().baseManifest!.files); expect(files).toHaveLength(2); expect(files.filter(f => f.deleted)).toHaveLength(1);
  });
  it('fails closed for a missing or corrupt Manifest and does not write notes', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync();
    remote.external({ 'A.md': 'a' }); const p = await a.service.preview(options, 'test'); expect(p.canExecute).toBe(false);
    await expect(a.service.execute(p, 'test')).rejects.toThrow(); expect(a.vault.mutations).toEqual([]);
    remote.external({ 'A.md': 'a', '.local-mirror-sync/manifest.json': '{bad' }); await expect(a.service.preview(options, 'test')).rejects.toThrow();
  });
  it('refuses overwrite if a local file changes after remote publication', async () => {
    const remote = new GitFixture({ 'A.md': 'remote' }); const a = await device(remote, { 'A.md': 'local' });
    const p = await a.service.preview(options, 'test'); const r = a.service.selectAdoption(p, 'remote');
    remote.beforePatch = () => a.vault.files.set('A.md', bytes('concurrent local'));
    await expect(a.service.execute(r, 'test', () => {}, undefined, 'USE REMOTE')).rejects.toThrow(); expect(a.vault.files.get('A.md')).toEqual(bytes('concurrent local'));
    expect(a.state.current().baseManifest).toBeUndefined(); expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('refuses a second execution while the first is running', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); const p = await a.service.preview(options, 'test');
    const first = a.service.execute(p, 'test'); await expect(a.service.execute(p, 'test')).rejects.toThrow('already running'); await first;
  });
  it('cancellation before publication has no writes or BASE advancement', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); const p = await a.service.preview(options, 'test'); const abort = new AbortController(); abort.abort();
    await expect(a.service.execute(p, 'test', () => {}, abort.signal)).rejects.toThrow(); expect(remote.calls.every(c => c.method === 'GET')).toBe(true);
    expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('leaves a damaged journal intact and blocks Preview and recovery', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); remote.losePatchResponse = true;
    await expect(a.sync()).rejects.toThrow(); const t = (await a.service.transactions.active())!;
    a.vault.internal.set(`${a.service.transactions.directory(t.id)}/journal.json`, '{}');
    a.vault.internal.set(`${a.service.transactions.directory(t.id)}/journal-copy.json`, '{}');
    await expect(a.service.preview(options, 'test')).rejects.toThrow(); await expect(a.service.resume(options, 'test')).rejects.toThrow();
    expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('recovers a torn journal checkpoint through its separately verified copy', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); remote.losePatchResponse = true;
    await expect(a.sync()).rejects.toThrow(); const t = (await a.service.transactions.active())!;
    a.vault.internal.set(`${a.service.transactions.directory(t.id)}/journal.json`, '{partial');
    await a.service.resume(options, 'test'); expect(a.state.current().baseManifest?.generation).toBe(1);
  });
  it('does not recreate a remote-deleted file from an offline device', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync(); const b = await device(remote); await b.sync();
    a.vault.files.delete('A.md'); await a.sync(); const head = remote.head; await b.sync();
    expect(b.vault.files.has('A.md')).toBe(false); expect(remote.head).toBe(head); expect(remote.contents()['A.md']).toBeUndefined();
  });
  it('preserves the losing conflict bytes in verified backup storage', async () => {
    const remote = new GitFixture({ 'A.md': 'remote' }); const a = await device(remote, { 'A.md': 'local' }); const p = await a.service.preview(options, 'test');
    await a.service.execute(a.service.selectAdoption(p, 'remote'), 'test', () => {}, undefined, 'USE REMOTE');
    expect([...a.vault.internal.entries()].some(([path, value]) => path.includes('/blobs/') && value === btoa('local'))).toBe(true);
  });
  it('also preserves remote legacy bytes when an adoption conflict explicitly chooses local', async () => {
    const remote = new GitFixture({ 'A.md': 'remote' }); const a = await device(remote, { 'A.md': 'local' }); const p = await a.service.preview(options, 'test');
    await a.service.execute(a.service.selectAdoption(p, 'local'), 'test', () => {}, undefined, 'USE LOCAL');
    expect(remote.text('A.md')).toBe('local');
    expect([...a.vault.internal.entries()].some(([path, value]) => path.includes('/blobs/') && value === btoa('remote'))).toBe(true);
  });
  it('blocks unexpected remote response hashes before local mutation', async () => {
    const remote = new GitFixture({ 'A.md': 'remote' }); const a = await device(remote); const p = await a.service.preview(options, 'test');
    const blob = remote.contents()['A.md']!; remote.blobs.set(blob, bytes('corrupt'));
    await expect(a.service.execute(a.service.selectAdoption(p, 'remote'), 'test', () => {}, undefined, 'USE REMOTE')).rejects.toThrow(); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('discards only an unpublished transaction after a branch race', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); remote.beforePatch = () => remote.external({ 'R.md': 'race' });
    await expect(a.sync()).rejects.toThrow(); await a.service.discardUnpublished(options, 'test'); expect(await a.service.transactions.active()).toBeNull();
    await a.sync(); expect(a.vault.files.get('R.md')).toEqual(bytes('race'));
  });
  it('rejects discarding a published commit whose response was lost', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); remote.losePatchResponse = true;
    await expect(a.sync()).rejects.toThrow(); await expect(a.service.discardUnpublished(options, 'test')).rejects.toThrow('published'); await a.service.resume(options, 'test');
  });
  it('inspects both legacy adoption versions before a resolution', async () => {
    const remote = new GitFixture({ 'A.md': 'remote' }); const a = await device(remote, { 'A.md': 'local' });
    const p = await a.service.preview(options, 'test'); const inspection = await a.service.inspect(p, p.plan.entries[0]!, 'test');
    expect(inspection).toContain('remote'); expect(inspection).toContain('local');
  });
  it('shows both paths when explicitly resolving an incompatible rename', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync(); const b = await device(remote); await b.sync();
    a.vault.files.set('left.md', bytes('a')); a.vault.files.delete('A.md'); await a.state.recordRename('A.md', 'left.md'); await a.sync();
    b.vault.files.set('right.md', bytes('a')); b.vault.files.delete('A.md'); await b.state.recordRename('A.md', 'right.md');
    const p = await b.service.preview(options, 'test'); const resolved = b.service.resolve(p, p.plan.entries[0]!.fileId!, 'remote');
    expect(resolved.plan.entries[0]).toMatchObject({ oldPath: 'right.md', path: 'left.md', category: 'PULL_RENAME' });
    await b.service.execute(resolved, 'test'); expect(b.vault.files.get('left.md')).toEqual(bytes('a')); expect(b.vault.files.has('right.md')).toBe(false);
  });
  it('does not let mutable display fields bypass execution guards', async () => {
    const remote = new GitFixture({ 'A.md': 'remote' }); const a = await device(remote, { 'A.md': 'local' });
    const p = await a.service.preview(options, 'test'); p.canExecute = true; p.plan.hasConflicts = false; p.plan.entries = [];
    await expect(a.service.execute(p, 'test')).rejects.toThrow('Resolve every conflict');
  });
  it('attaches a recreated path to its live identity, not the historical tombstone', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync();
    a.vault.files.delete('A.md'); await a.state.recordDelete('A.md'); await a.sync(); a.vault.files.set('A.md', bytes('new')); await a.state.recordCreate('A.md'); await a.sync();
    const b = await device(remote, { 'A.md': 'new' }); const p = await b.service.preview(options, 'test'); expect(p.plan.hasConflicts).toBe(false); await b.service.execute(p, 'test');
  });
  it('never mutates either path of an ignored cross-boundary rename', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); await a.sync();
    a.vault.files.set('private/A.md', bytes('edited privately')); a.vault.files.delete('A.md'); await a.state.recordRename('A.md', 'private/A.md');
    const p = await a.service.preview({ ...options, ignorePatterns: 'private/' }, 'test');
    expect(p.plan.entries).toEqual([]); await a.service.execute(p, 'test'); expect(remote.text('A.md')).toBe('a'); expect(a.vault.files.get('private/A.md')).toEqual(bytes('edited privately'));
  });
  it.each(['blobs', 'trees', 'commits', 'refs/heads/main'])('failure at GitHub %s keeps BASE unchanged', async resource => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' });
    const transport = remote.transport; remote.transport = async req => req.method !== 'GET' && req.url.endsWith('/' + resource) ? { status: 403, json: {} } : transport(req);
    const service = new SyncService(a.vault, remote.transport, '.obsidian', a.state);
    const p = await service.preview(options, 'test'); await expect(service.execute(p, 'test')).rejects.toThrow(); expect(a.state.current().baseManifest).toBeUndefined(); expect(a.vault.mutations).toEqual([]);
  });
  it('recovers its pinned commit even when another device advanced the branch', async () => {
    const remote = new GitFixture(); const a = await device(remote, { 'A.md': 'a' }); remote.losePatchResponse = true; await expect(a.sync()).rejects.toThrow();
    const b = await device(remote); await b.sync(); b.vault.files.set('B.md', bytes('b')); await b.sync(); const latest = remote.head;
    await a.service.resume(options, 'test'); expect(remote.head).toBe(latest); await a.sync(); expect(a.vault.files.get('B.md')).toEqual(bytes('b'));
  });
  for (let seed = 1; seed <= 12; seed++) it(`executor two-device state machine seed ${seed}`, async () => {
    let rng = seed; const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng; };
    const remote = new GitFixture(); const a = await device(remote, { 'seed.md': 'seed' }); await a.sync(); const b = await device(remote); await b.sync();
    const expected = new Map<string, string>([['seed.md', 'seed']]); let tombstones = 0;
    for (let step = 0; step < 25; step++) {
      const d = random() % 2 ? a : b; const keys = [...expected.keys()]; const op = random() % 4; const path = keys[random() % Math.max(1, keys.length)];
      if (!path || op === 0) { const path = `new-${seed}-${step}.md`; const value = `v-${random()}`; expected.set(path, value); d.vault.files.set(path, bytes(value)); }
      else if (op === 1) { const value = `edited-${random()}`; expected.set(path, value); d.vault.files.set(path, bytes(value)); }
      else if (op === 2) { expected.delete(path); d.vault.files.delete(path); await d.state.recordDelete(path); tombstones++; }
      else { const destination = `renamed-${seed}-${step}.md`; const value = `rename-edit-${random()}`; expected.delete(path); expected.set(destination, value); d.vault.files.delete(path); d.vault.files.set(destination, bytes(value)); await d.state.recordRename(path, destination); }
      await d.sync(); await (d === a ? b : a).sync();
      const actual = Object.fromEntries(Object.keys(remote.contents()).filter(p => !p.startsWith('.')).map(p => [p, remote.text(p)]));
      expect(actual).toEqual(Object.fromEntries(expected));
      for (const d of [a, b]) {
        expect(Object.fromEntries([...d.vault.files].filter(([p]) => !p.startsWith('.')).map(([p, bytes]) => [p, new TextDecoder().decode(bytes)]))).toEqual(actual);
        expect(Object.values(d.state.current().baseManifest!.files).filter(f => f.deleted)).toHaveLength(tombstones);
      }
    }
  });
});
