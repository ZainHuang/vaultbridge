import { describe, expect, it } from 'vitest';
import { InitializationGate } from '../src/sync/InitializationGate';
import { SyncPlanner } from '../src/sync/SyncPlanner';
import { assertInitializationAllowsExecution, type PreviewResult } from '../src/sync/PreviewResult';
import { IgnoreService } from '../src/vault/IgnoreService';
import type { DeviceState } from '../src/state/DeviceState';
import { PRIMARY_CONFIRMATION, primaryDeclarationBlock, StateStore, type DeviceStateStorage } from '../src/state/StateStore';
import { PreviewService } from '../src/sync/PreviewService';
import { InitializationSession } from '../src/sync/InitializationSession';
import { DEFAULT_SETTINGS, loadSettings } from '../src/settings/settings';
import { VaultScanner } from '../src/vault/VaultScanner';
import { bytes, HEAD, localSnapshot, MemoryVault, remoteSnapshot, remoteTransport, target, treeEntries, TREE } from './helpers';

const deviceId = '550e8400-e29b-41d4-a716-446655440000';
const uninitialized: DeviceState = { deviceId, initializationState: 'UNINITIALIZED' };
const primary = (count: number): DeviceState => ({ deviceId, initializationState: 'INITIALIZED_AS_PRIMARY', initializationMode: 'local-primary', initializationTimestamp: '2026-09-16T00:00:00.000Z', lastVerifiedLocalFileCount: count });
const ignore = new IgnoreService({ configDir: '.obsidian', includeObsidian: false, patterns: '', gitignore: '' });
const files = (count: number, prefix = 'note') => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}-${index}.md`, `body-${index}`]));
function preview(localCount: number, remoteCount: number, state = uninitialized): PreviewResult {
  const local = localSnapshot(files(localCount));
  const remote = remoteSnapshot(files(remoteCount));
  const gate = new InitializationGate().evaluate(local, remote, state, ignore);
  const plan = new SyncPlanner().create(local, remote, ignore, target);
  return { deviceState: { ...state }, gate, plan, executionAllowed: gate.status === 'ALLOW' && !plan.hasConflicts };
}

class MemoryStateStorage implements DeviceStateStorage {
  contents: string | null;
  writes: string[] = [];
  fail = false;
  constructor(state?: unknown) { this.contents = state === undefined ? null : JSON.stringify(state); }
  async read() { return this.contents; }
  async write(contents: string) { if (this.fail) throw new Error('disk'); this.writes.push(contents); this.contents = contents; }
}

describe('Initialization Gate required cases', () => {
  it('Case 1: new 0/245 is blocked, even though diagnostics contain DELETE_REMOTE 245', () => {
    const result = preview(0, 245);
    expect(result.gate.status).toBe('BLOCK_NEW_DEVICE');
    expect(result.executionAllowed).toBe(false);
    expect(result.plan.operationCounts.DELETE_REMOTE).toBe(245);
    expect(result.gate.suggestedAction).toBe('INITIALIZE_FROM_REMOTE');
    expect(() => assertInitializationAllowsExecution(result)).toThrow(/blocked/);
  });
  it('Case 2: new 3/245 is blocked', () => {
    expect(preview(3, 245).gate.status).toBe('BLOCK_NEW_DEVICE');
  });
  it('Case 3: new 100/245 has 145 deletions (59.18%) and is blocked', () => {
    const result = preview(100, 245);
    expect(result.plan.operationCounts.DELETE_REMOTE).toBe(145);
    expect(145 / 245 * 100).toBeCloseTo(59.18, 2);
    expect(result.gate.status).toBe('BLOCK_FIRST_SYNC_MASS_DELETE');
    expect(result.executionAllowed).toBe(false);
  });
  it('Case 4: declared Primary 245/370 permits initialization eligibility and retains high-risk deletion notice', () => {
    const result = preview(245, 370, primary(245));
    expect(result.gate.status).toBe('ALLOW'); expect(result.executionAllowed).toBe(true);
    expect(result.plan.operationCounts.DELETE_REMOTE).toBe(125); expect(result.plan.highRisk).toBe(true);
    expect(() => assertInitializationAllowsExecution(result)).not.toThrow();
  });
  it('Case 5: initialized 245 baseline suddenly becomes 2/245', () => {
    expect(preview(2, 245, primary(245)).gate.status).toBe('BLOCK_SUSPICIOUS_EMPTY_LOCAL');
    expect(preview(2, 245, primary(245)).executionAllowed).toBe(false);
  });
  it('Case 6: actual 3-file Primary Vault is allowed', () => {
    expect(preview(3, 3, primary(3)).gate.status).toBe('ALLOW');
  });
  it('Case 7: empty remote does not initialize a device; declaration is available', () => {
    const result = preview(245, 0);
    expect(result.deviceState.initializationState).toBe('UNINITIALIZED');
    expect(result.gate.suggestedAction).toBe('DECLARE_LOCAL_PRIMARY');
    expect(result.executionAllowed).toBe(false);
    expect(primaryDeclarationBlock(result)).toBeUndefined();
  });
  it.each(['.obsidian', 'custom-config'])('Case 8: state, token and plugin files in %s cannot enter snapshots under !**', async configDir => {
    const protectedFiles = ['device-state.json', 'data.json', 'manifest.json', 'main.js'];
    const vault = new MemoryVault({ 'note.md': 'ok', ...Object.fromEntries(protectedFiles.map(name => [`${configDir}/plugins/local-mirror-sync/${name}`, 'private'])) });
    const rules = new IgnoreService({ configDir, includeObsidian: true, patterns: '!**', gitignore: '' });
    const local = await new VaultScanner(vault).scan(rules);
    expect(local.files.map(file => file.path)).toEqual(['note.md']);
    expect(vault.reads).toEqual(['note.md']);
    const plan = new SyncPlanner().create(local, remoteSnapshot(Object.fromEntries(protectedFiles.map(name => [`${configDir}/plugins/local-mirror-sync/${name}`, 'private']))), rules, target);
    expect(plan.counts.IGNORED).toBe(4); expect(plan.remoteCount).toBe(0);
    expect(plan.operationCounts.DELETE_REMOTE).toBe(0);
  });
});

describe('Gate boundaries and bypass resistance', () => {
  it.each([
    [5, 20, 'BLOCK_NEW_DEVICE'], [6, 20, 'BLOCK_FIRST_SYNC_MASS_DELETE'],
    [10, 20, 'BLOCK_FIRST_SYNC_MASS_DELETE'], [11, 20, 'BLOCK_NEW_DEVICE'],
    [5, 19, 'BLOCK_FIRST_SYNC_MASS_DELETE'], [0, 1, 'BLOCK_NEW_DEVICE'],
    [0, 0, 'BLOCK_NEW_DEVICE'], [245, 245, 'BLOCK_NEW_DEVICE'],
  ])('new device %i/%i yields %s', (local, remote, status) => {
    const result = preview(local, remote); expect(result.gate.status).toBe(status); expect(result.executionAllowed).toBe(false);
  });
  it.each([
    [20, 5, 20, 'BLOCK_SUSPICIOUS_EMPTY_LOCAL'], [19, 5, 20, 'ALLOW'],
    [20, 6, 20, 'ALLOW'], [20, 5, 19, 'ALLOW'],
  ])('initialized previous=%i local=%i remote=%i yields %s', (previous, local, remote, status) => {
    expect(preview(local, remote, primary(previous)).gate.status).toBe(status);
  });
  it('counts exact-content rename old paths as remote removals before planning', () => {
    const local = localSnapshot(files(20, 'renamed'));
    const remote = remoteSnapshot(files(20));
    expect(new SyncPlanner().create(local, remote, ignore, target).counts.RENAME).toBe(20);
    expect(new InitializationGate().evaluate(local, remote, uninitialized, ignore).status).toBe('BLOCK_FIRST_SYNC_MASS_DELETE');
  });
  it('uses eligible counts after ignore on both sides', () => {
    const local = localSnapshot({ ...files(3), ...files(30, 'ignored') });
    const remote = remoteSnapshot({ ...files(19), ...files(50, 'ignored') });
    const rules = new IgnoreService({ configDir: '.obsidian', includeObsidian: false, patterns: 'ignored*', gitignore: '' });
    expect(new InitializationGate().evaluate(local, remote, primary(245), rules).status).toBe('ALLOW');
    expect(new SyncPlanner().create(local, remote, rules, target).remoteCount).toBe(19);
  });
  it('rejects an altered flag while the initialization Gate is still blocked', () => {
    const result = preview(0, 245); result.executionAllowed = true;
    expect(() => assertInitializationAllowsExecution(result)).toThrow(/blocked/);
  });
  it('applies suspicious-empty protection to previously remote-initialized devices too', () => {
    expect(preview(2, 245, { ...primary(245), initializationState: 'INITIALIZED_FROM_REMOTE', initializationMode: 'remote-bootstrap', lastVerifiedRemoteCommit: HEAD }).gate.status).toBe('BLOCK_SUSPICIOUS_EMPTY_LOCAL');
  });
});

describe('Local StateStore lifecycle', () => {
  it('generates and persists a UUID once, independently from ordinary settings', async () => {
    const storage = new MemoryStateStorage(); const store = new StateStore(storage);
    const first = await store.load();
    expect(first.initializationState).toBe('UNINITIALIZED'); expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await new StateStore(storage).load()).deviceId).toBe(first.deviceId);
    expect(storage.writes).toHaveLength(1);
    expect(loadSettings({ ...DEFAULT_SETTINGS, initializationState: 'INITIALIZED_AS_PRIMARY' })).not.toHaveProperty('initializationState');
  });
  it.each([{}, { ...primary(245), initializationTimestamp: undefined }, { ...primary(245), initializationMode: 'remote-bootstrap' }, { ...primary(245), lastVerifiedLocalFileCount: -1 }, { ...primary(245), deviceId: 'bad' }, { ...primary(245), initializationState: 'INITIALIZED_FROM_REMOTE', initializationMode: 'remote-bootstrap' }])('invalid / incomplete saved state fails closed case %#', async input => {
    const store = new StateStore(new MemoryStateStorage(input));
    expect((await store.load()).initializationState).toBe('UNINITIALIZED');
  });
  it('malformed JSON and removed state restart as UNINITIALIZED', async () => {
    const storage = new MemoryStateStorage(primary(245)); storage.contents = '{partial';
    expect((await new StateStore(storage).load()).initializationState).toBe('UNINITIALIZED');
    storage.contents = null;
    expect((await new StateStore(storage).load()).initializationState).toBe('UNINITIALIZED');
  });
  it('unreadable state blocks instead of assuming it is absent', async () => {
    const store = new StateStore({ read: async () => { throw new Error('disk'); }, write: async () => {} });
    await expect(store.load()).rejects.toMatchObject({ code: 'READ_FAILED' });
  });
  it('successful diagnostic Preview records time but never initializes or overwrites verified baseline', async () => {
    const storage = new MemoryStateStorage(primary(245)); const store = new StateStore(storage); await store.load();
    await store.recordSuccessfulPreview(preview(2, 245, store.current()));
    await store.recordSuccessfulPreview(preview(0, 245, store.current()));
    expect(store.current().lastVerifiedLocalFileCount).toBe(245);
    expect(store.current().lastSuccessfulPreviewAt).toBeTruthy();
    expect(store.current().lastVerifiedRemoteCommit).toBeUndefined();
    const fresh = new StateStore(new MemoryStateStorage(uninitialized)); await fresh.load();
    await fresh.recordSuccessfulPreview(preview(245, 0));
    expect(fresh.current().initializationState).toBe('UNINITIALIZED');
  });
  it.each(['', 'use local as primary', 'USE LOCAL AS PRIMARY ', ' USE LOCAL AS PRIMARY'])('requires exact phrase (%s) in the state layer', async phrase => {
    const storage = new MemoryStateStorage(uninitialized); const store = new StateStore(storage); await store.load();
    await expect(store.declareLocalPrimary(phrase, preview(100, 245))).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(storage.writes).toHaveLength(0);
  });
  it('strong confirmation persists Primary, mode, time and local count without claiming remote verification', async () => {
    const storage = new MemoryStateStorage(uninitialized); const store = new StateStore(storage); await store.load();
    await store.declareLocalPrimary(PRIMARY_CONFIRMATION, preview(100, 245));
    const reloaded = await new StateStore(storage).load();
    expect(reloaded).toMatchObject({ deviceId, initializationState: 'INITIALIZED_AS_PRIMARY', initializationMode: 'local-primary', lastVerifiedLocalFileCount: 100 });
    expect(reloaded.initializationTimestamp).toBeTruthy(); expect(reloaded.lastVerifiedRemoteCommit).toBeUndefined();
    expect(preview(100, 245, reloaded).gate.status).toBe('ALLOW');
    expect(JSON.parse(storage.contents!)).not.toHaveProperty('localToken');
  });
  it.each([0, 3, 5])('declaration cannot promote near-empty %i/245', async count => {
    const store = new StateStore(new MemoryStateStorage(uninitialized)); await store.load();
    await expect(store.declareLocalPrimary(PRIMARY_CONFIRMATION, preview(count, 245))).rejects.toMatchObject({ code: 'DECLARATION_BLOCKED' });
  });
  it('redeclaring Primary cannot reset suspicious-empty baseline', async () => {
    const store = new StateStore(new MemoryStateStorage(primary(245))); await store.load();
    await expect(store.declareLocalPrimary(PRIMARY_CONFIRMATION, preview(2, 245, primary(245)))).rejects.toMatchObject({ code: 'DECLARATION_BLOCKED' });
    expect(store.current().lastVerifiedLocalFileCount).toBe(245);
  });
  it('an entirely empty local and remote cannot establish an empty Primary baseline', async () => {
    const store = new StateStore(new MemoryStateStorage(uninitialized)); await store.load();
    await expect(store.declareLocalPrimary(PRIMARY_CONFIRMATION, preview(0, 0))).rejects.toMatchObject({ code: 'DECLARATION_BLOCKED' });
    expect(store.current().initializationState).toBe('UNINITIALIZED');
  });
  it('a failed state write or read-back leaves no trusted in-memory authority', async () => {
    const storage = new MemoryStateStorage(uninitialized); const store = new StateStore(storage); await store.load(); storage.fail = true;
    await expect(store.declareLocalPrimary(PRIMARY_CONFIRMATION, preview(100, 245))).rejects.toMatchObject({ code: 'SAVE_FAILED' });
    expect(() => store.current()).toThrow(/unavailable/);
    const mismatch = new StateStore({ read: async () => null, write: async () => {} });
    await expect(mismatch.load()).rejects.toMatchObject({ code: 'SAVE_FAILED' });
  });
  it('serializes duplicate declarations and late Preview audit without downgrading authority', async () => {
    const store = new StateStore(new MemoryStateStorage(uninitialized)); await store.load(); const result = preview(100, 245);
    const results = await Promise.allSettled([store.declareLocalPrimary(PRIMARY_CONFIRMATION, result), store.declareLocalPrimary(PRIMARY_CONFIRMATION, result), store.recordSuccessfulPreview(result)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(store.current().initializationState).toBe('INITIALIZED_AS_PRIMARY');
  });
});

describe('Full Preview and explicit declaration integration', () => {
  async function setup() {
    const vault = new MemoryVault(files(100));
    let remoteHead = HEAD;
    const calls: string[] = [];
    const remote = treeEntries(Object.fromEntries(Object.entries(files(245)).map(([path, value]) => [path, bytes(value)])));
    const storage = new MemoryStateStorage(uninitialized); const store = new StateStore(storage); await store.load();
    const base = remoteTransport(remote);
    const service = new PreviewService(vault, async request => {
      calls.push(request.method);
      if (request.url.includes('/ref/')) return { status: 200, json: { ref: 'refs/heads/main', object: { type: 'commit', sha: remoteHead } } };
      if (request.url.includes('/commits/')) return { status: 200, json: { sha: remoteHead, tree: { sha: TREE } } };
      return base(request);
    }, '.obsidian', () => store.current());
    let version = '1';
    const session = new InitializationSession(store, (progress, signal) => service.preview({ ...DEFAULT_SETTINGS, ...target }, '', progress, signal), () => version);
    const signal = new AbortController().signal;
    return { vault, store, storage, calls, session, signal, setHead: () => { remoteHead = 'd'.repeat(40); }, setVersion: () => { version = '2'; } };
  }
  it('end-to-end new-device block → reviewed declaration → fresh ALLOW, network remains GET only', async () => {
    const test = await setup(); const first = await test.session.preview(() => {}, test.signal);
    expect(first.gate.status).toBe('BLOCK_FIRST_SYNC_MASS_DELETE'); expect(first.executionAllowed).toBe(false);
    await test.session.declarePrimary(first, PRIMARY_CONFIRMATION, test.signal);
    const next = await test.session.preview(() => {}, test.signal);
    expect(next.executionAllowed).toBe(true); expect(next.plan.operationCounts.DELETE_REMOTE).toBe(145);
    expect(test.calls.every(method => method === 'GET')).toBe(true);
    expect(test.vault.files.size).toBe(100);
  });
  it.each(['local hash', 'remote HEAD'])('rejects declaration after %s changes since Preview', async change => {
    const test = await setup(); const first = await test.session.preview(() => {}, test.signal);
    if (change === 'local hash') test.vault.files.set('note-0.md', bytes('changed'));
    else test.setHead();
    await expect(test.session.declarePrimary(first, PRIMARY_CONFIRMATION, test.signal)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(test.store.current().initializationState).toBe('UNINITIALIZED');
  });
  it('cancelled confirmation never initializes a device', async () => {
    const test = await setup(); const first = await test.session.preview(() => {}, test.signal);
    const controller = new AbortController(); controller.abort();
    await expect(test.session.declarePrimary(first, PRIMARY_CONFIRMATION, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(test.store.current().initializationState).toBe('UNINITIALIZED');
  });
  it('rejects changed settings context even when file hashes remain identical', async () => {
    const test = await setup(); const first = await test.session.preview(() => {}, test.signal);
    test.setVersion();
    await expect(test.session.declarePrimary(first, PRIMARY_CONFIRMATION, test.signal)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(test.store.current().initializationState).toBe('UNINITIALIZED');
  });
});
