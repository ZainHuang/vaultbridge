import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { ProductStore } from '../src/product/ProductStore';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
async function fixture(newDevice = true) {
  const remote = new GitFixture({ 'old.md': 'old remote' });
  const vault = new WritableVault({ 'note.md': 'published local' });
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const service = new SyncService(vault, req => remote.transport(req), '.obsidian', state);
  const preview = service.selectAdoption(await service.preview(options, 'test'), 'local');
  // Real publication, interrupted before the first BASE save.
  const save = state.save.bind(state); state.save = async () => { throw new Error('power loss'); };
  await expect(service.execute(preview, 'test', () => {}, undefined, 'USE LOCAL')).rejects.toThrow('power loss');
  state.save = save;
  const t = (await service.transactions.active())!;
  delete t.createdAt; delete t.observation; t.phase = 'published';
  await service.transactions.save(t);
  if (newDevice) await state.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
  const product = new ProductStore({ read: p => vault.readInternal('product/' + p), write: (p, s) => vault.writeInternal('product/' + p, s) });
  await product.load(state.current().deviceId, 'Current device', 'desktop');
  await product.failure(new Error('pending'), true);
  const recovery = new SyncService(vault, req => remote.transport(req), '.obsidian', state, product);
  vault.mutations.length = 0;
  return { remote, vault, state, service: recovery, t, product };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function advance(a: Fixture, localMatches = true) {
  const manifest = structuredClone(a.t.manifest);
  manifest.generation++;
  const entry = Object.values(manifest.files)[0]!;
  entry.path = 'renamed.md'; entry.revision++; entry.blobSha = a.remote.blob(bytes('current content'));
  manifest.files.removed = { fileId: 'removed', path: 'removed.md', deleted: true, revision: 2 };
  a.remote.external({ 'renamed.md': 'current content', [MANIFEST_PATH]: JSON.stringify(manifest) });
  if (localMatches) { a.vault.files.delete('note.md'); a.vault.files.set('renamed.md', bytes('current content')); }
  return manifest;
}
function journal(a: Fixture) {
  return JSON.parse(JSON.parse(a.vault.internal.get(`${a.service.transactions.directory(a.t.id)}/journal.json`)!).payload);
}
async function blocked(a: Fixture, code: string, message?: string, settings = options) {
  const before = a.state.current(); const files = new Map(a.vault.files); const refs = new Map(a.remote.refs);
  const journal = await a.service.transactions.active(); const calls = a.remote.calls.length;
  await expect(a.service.resume(settings, 'test')).rejects.toMatchObject({ code, ...(message ? { message: expect.stringContaining(message) } : {}) });
  expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files); expect(a.vault.mutations).toEqual([]);
  expect(a.remote.refs).toEqual(refs); expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  expect(await a.service.transactions.active()).toEqual(journal);
  await expect(a.service.preview(settings, 'test')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
}

describe('V1.0 published recovery verified from current bytes', () => {
  it.each([true, false])('rebuilds missing BASE without requiring V1.1 metadata (new device: %s)', async newDevice => {
    const a = await fixture(newDevice); const deviceId = a.state.current().deviceId;
    const files = new Map(a.vault.files); const refs = new Map(a.remote.refs); const count = a.remote.calls.length;
    await a.service.resume(options, 'test');
    expect(a.state.current()).toMatchObject({ deviceId, baseManifest: a.t.manifest, baseRemoteCommit: a.t.commit, lastSeenGeneration: a.t.manifest.generation });
    expect(a.product.snapshot()).toMatchObject({ status: 'Healthy', currentDevice: { deviceId } });
    expect(a.product.cachedHistory()).toEqual([]);
    expect(a.vault.files).toEqual(files); expect(a.vault.mutations).toEqual([]); expect(a.remote.refs).toEqual(refs);
    const calls = a.remote.calls.slice(count); expect(calls.every(c => c.method === 'GET')).toBe(true);
    for (const prefix of ['ref/heads/main', 'commits/', 'trees/', 'blobs/']) expect(calls.some(c => c.resource.startsWith(prefix))).toBe(true);
    expect(await a.service.transactions.active()).toBeNull();
    expect(JSON.parse(JSON.parse(a.vault.internal.get(`${a.service.transactions.directory(a.t.id)}/journal.json`)!).payload).phase).toBe('complete');
    expect((await a.service.preview(options, 'test')).mode).toBe('SYNC');
  });
  it.each(['changed', 'missing', 'extra'])('blocks %s local bytes with the path and no apply', async mode => {
    const a = await fixture();
    if (mode === 'changed') a.vault.files.set('note.md', bytes('local edit'));
    if (mode === 'missing') a.vault.files.delete('note.md');
    if (mode === 'extra') a.vault.files.set('extra.md', bytes('new note'));
    await blocked(a, 'LEGACY_LOCAL_MISMATCH', mode === 'extra' ? 'extra.md' : 'note.md');
  });
  it.each(['rollback', 'diverged'])('blocks %s even with otherwise matching content', async mode => {
    const a = await fixture();
    const files = Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)]));
    a.remote.head = a.t.originalHead;
    if (mode === 'diverged') a.remote.external(files);
    await blocked(a, 'LEGACY_RECOVERY_DIVERGED', a.remote.head);
  });
  it.each(['same tree', 'new generation', 'merge ancestor'])('recovers to current HEAD with %s and only current content proof', async mode => {
    const a = await fixture();
    const manifest = mode === 'new generation' ? advance(a) : a.t.manifest;
    if (mode !== 'new generation') a.remote.external(Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)])));
    if (mode === 'merge ancestor') a.remote.commits.get(a.remote.head)!.parents = [a.t.originalHead, a.t.commit];
    const head = a.remote.head; const refs = new Map(a.remote.refs); const files = new Map(a.vault.files); const count = a.remote.calls.length;
    a.vault.apply = async () => { throw new Error('recovery must never apply'); };
    await a.service.resume(options, 'test');
    expect(a.state.current()).toMatchObject({ baseManifest: manifest, baseRemoteCommit: head, lastSeenGeneration: manifest.generation, localFiles: manifest.files });
    expect(a.product.snapshot()).toMatchObject({ status: 'Healthy', currentDevice: { lastGeneration: manifest.generation } });
    expect(journal(a)).toMatchObject({ phase: 'complete', commit: a.t.commit, manifest: a.t.manifest,
      legacyRecovery: { action: 'RECOVER_TO_CURRENT_HEAD', head, generation: manifest.generation } });
    expect(a.remote.calls.slice(count).some(c => c.resource === `commits/${head}`)).toBe(true);
    expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true);
    expect(a.remote.head).toBe(head); expect(a.remote.refs).toEqual(refs); expect(a.vault.files).toEqual(files); expect(a.vault.mutations).toEqual([]);
    expect(await a.service.transactions.active()).toBeNull(); expect((await a.service.preview(options, 'test')).mode).toBe('SYNC');
  });
  it.each(['local', 'remote tree', 'both'])('retains BASE for %s differences and releases only on explicit fresh Preview', async mode => {
    const a = await fixture(); const manifest = advance(a, mode === 'remote tree');
    if (mode !== 'local') a.remote.contents()['extra.md'] = a.remote.blob(bytes('untracked remote'));
    await blocked(a, 'LEGACY_CURRENT_STATE_DIFFERS', mode === 'remote tree' ? 'extra.md' : 'note.md');
    const before = a.state.current(); const files = new Map(a.vault.files); const refs = new Map(a.remote.refs); const head = a.remote.head; const count = a.remote.calls.length;
    await a.service.startFreshPreviewFromCurrentHead(options, 'test', () => {}, a.t);
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files); expect(a.vault.mutations).toEqual([]);
    expect(a.remote.refs).toEqual(refs); expect(a.remote.head).toBe(head); expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true);
    expect(journal(a)).toMatchObject({ phase: 'published', commit: a.t.commit, legacyRecovery: { action: 'START_FRESH_PREVIEW', head, generation: manifest.generation, differences: expect.any(Array) } });
    expect(await a.service.transactions.active()).toBeNull(); expect(a.product.snapshot().status).not.toBe('Healthy');
    const preview = await a.service.preview(options, 'test');
    expect(preview.state).toEqual(before); expect(preview.mode).toBe(mode === 'local' ? 'ATTACH' : 'BLOCKED');
  });
  it('fresh Preview keeps a trusted existing BASE and normal three-way decisions', async () => {
    const a = await fixture(false);
    await a.state.save({ ...a.t.originalState, target, baseManifest: a.t.manifest, baseRemoteCommit: a.t.commit, lastSeenGeneration: 1, localFiles: a.t.manifest.files, syncScope: a.t.scopeKey });
    advance(a, false);
    await a.service.startFreshPreviewFromCurrentHead(options, 'test');
    const preview = await a.service.preview(options, 'test');
    expect(a.state.current().baseRemoteCommit).toBe(a.t.commit); expect(preview.mode).toBe('SYNC');
    expect(preview.plan.entries.some(e => e.category === 'PULL_RENAME_AND_UPDATE')).toBe(true);
  });
  it('fresh Preview clears cached Recovery Required without claiming verification or PASS history', async () => {
    const a = await fixture(); advance(a, false);
    await a.service.startFreshPreviewFromCurrentHead(options, 'test');
    expect(a.product.snapshot().status).toBe('Sync Required'); expect(a.product.cachedHistory()).toEqual([]);
    expect(a.state.current().baseManifest).toBeUndefined();
  });
  it.each(['head', 'local', 'state', 'journal', 'backup'])('rechecks %s before releasing fresh Preview', async mode => {
    const a = await fixture(); advance(a, false); const transport = a.remote.transport; let changed = false;
    a.remote.transport = async req => {
      const response = await transport(req);
      if (!changed && req.url.includes('/blobs/')) {
        changed = true;
        if (mode === 'head') a.remote.external(Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)])));
        if (mode === 'local') a.vault.files.set('note.md', bytes('concurrent edit'));
        if (mode === 'state') await a.state.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
        if (mode === 'journal') { a.t.phase = 'applying'; await a.service.transactions.save(a.t); }
        if (mode === 'backup') a.remote.refs.delete(a.t.backupRef!);
      }
      return response;
    };
    await expect(a.service.startFreshPreviewFromCurrentHead(options, 'test')).rejects.toMatchObject({ code: {
      head: 'REMOTE_ADVANCED_SINCE_LEGACY_TRANSACTION', local: 'LEGACY_LOCAL_MISMATCH', state: 'LEGACY_STATE_CHANGED',
      journal: 'LEGACY_TRANSACTION_CHANGED', backup: 'LEGACY_BACKUP_UNVERIFIED',
    }[mode] });
    expect(a.state.current().baseManifest).toBeUndefined(); expect(await a.service.transactions.active()).not.toBeNull();
    expect(a.vault.mutations).toEqual([]);
  });
  it.each(['offline', 'malformed history', 'limit'])('does not classify unverified ancestry as a descendant: %s', async mode => {
    const a = await fixture(); advance(a); const transport = a.remote.transport;
    if (mode === 'limit') for (let i = 0; i < 501; i++) a.remote.external({});
    a.remote.transport = async req => {
      if (req.url.includes('/commits/') && mode !== 'limit') return { status: mode === 'offline' ? 403 : 200, json: { sha: a.remote.head, parents: [{ sha: 'invalid' }] } };
      return transport(req);
    };
    await blocked(a, mode === 'offline' ? 'HTTP_403' : mode === 'limit' ? 'HISTORY_LIMIT' : 'INVALID_HISTORY');
  });
  it.each(['state', 'observer', 'complete journal', 'clear pointer'])('retries a current-HEAD %s checkpoint after reload', async checkpoint => {
    const a = await fixture(); const manifest = advance(a); const head = a.remote.head;
    const write = a.vault.writeInternal.bind(a.vault); let failed = false;
    a.vault.writeInternal = async (path, value) => {
      if (!failed && (checkpoint === 'state' && path === 'state' || checkpoint === 'observer' && path === 'product/product-state.json'
        || checkpoint === 'complete journal' && path.endsWith('/journal.json') && JSON.parse(JSON.parse(value).payload).phase === 'complete'
        || checkpoint === 'clear pointer' && path.endsWith('/active.json') && value === 'null')) { failed = true; throw new Error('disk full'); }
      await write(path, value);
    };
    await expect(a.service.resume(options, 'test')).rejects.toThrow(); expect(failed).toBe(true);
    await a.state.load(); await a.service.resume(options, 'test');
    expect(a.state.current()).toMatchObject({ baseRemoteCommit: head, baseManifest: manifest });
    expect(await a.service.transactions.active()).toBeNull(); expect(a.vault.mutations).toEqual([]);
  });
  it('retries after saved BASE when main advances again', async () => {
    const a = await fixture(); const manifest = advance(a);
    const verified = a.product.verified.bind(a.product); a.product.verified = async () => { throw new Error('interrupted observer'); };
    await expect(a.service.resume(options, 'test')).rejects.toThrow();
    a.product.verified = verified; await a.state.load();
    const entry = Object.values(manifest.files).find(f => !f.deleted)!; manifest.generation++; entry.revision++;
    entry.blobSha = a.remote.blob(bytes('even newer')); a.vault.files.set(entry.path, bytes('even newer'));
    a.remote.external({ [entry.path]: 'even newer', [MANIFEST_PATH]: JSON.stringify(manifest) });
    await a.service.resume(options, 'test');
    expect(a.state.current()).toMatchObject({ baseRemoteCommit: a.remote.head, baseManifest: manifest });
    expect(await a.service.transactions.active()).toBeNull();
  });
  it('does not replace a saved checkpoint BASE from a branch outside current ancestry', async () => {
    const a = await fixture(); advance(a);
    a.product.verified = async () => { throw new Error('interrupted observer'); };
    await expect(a.service.resume(options, 'test')).rejects.toThrow();
    const files = Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)]));
    a.remote.head = a.t.commit; a.remote.external(files);
    await blocked(a, 'LEGACY_RECOVERY_DIVERGED');
  });
  it('retains audit on interrupted fresh release and can retry after reload', async () => {
    const a = await fixture(); advance(a, false); const before = a.state.current();
    const clear = a.service.transactions.clear.bind(a.service.transactions);
    a.service.transactions.clear = async () => { throw new Error('pointer write failed'); };
    await expect(a.service.startFreshPreviewFromCurrentHead(options, 'test')).rejects.toThrow();
    expect(journal(a).legacyRecovery.action).toBe('START_FRESH_PREVIEW');
    expect(await a.service.transactions.active()).not.toBeNull(); expect(a.state.current()).toEqual(before);
    a.service.transactions.clear = clear; await a.state.load();
    await a.service.startFreshPreviewFromCurrentHead(options, 'test');
    expect(await a.service.transactions.active()).toBeNull(); expect(a.state.current()).toEqual(before);
  });
  it('survives a second failed BASE save after main advances beyond a saved recovery BASE', async () => {
    const a = await fixture(); const manifest = advance(a);
    const verified = a.product.verified.bind(a.product); a.product.verified = async () => { throw new Error('observer interrupted'); };
    await expect(a.service.resume(options, 'test')).rejects.toThrow(); a.product.verified = verified;
    const entry = Object.values(manifest.files).find(f => !f.deleted)!; manifest.generation++; entry.revision++;
    entry.blobSha = a.remote.blob(bytes('next generation')); a.vault.files.set(entry.path, bytes('next generation'));
    a.remote.external({ [entry.path]: 'next generation', [MANIFEST_PATH]: JSON.stringify(manifest) });
    const save = a.state.save.bind(a.state); a.state.save = async () => { throw new Error('second power loss'); };
    await expect(a.service.resume(options, 'test')).rejects.toThrow(); a.state.save = save;
    await a.state.load(); await a.service.resume(options, 'test');
    expect(a.state.current()).toMatchObject({ baseRemoteCommit: a.remote.head, baseManifest: manifest });
    expect(await a.service.transactions.active()).toBeNull();
  });
  it('verifies current scope when a descendant deleted a previously published .gitignore', async () => {
    const a = await fixture(); const sha = a.remote.blob(bytes('cache/'));
    a.t.manifest.files.rules = { fileId: 'rules', path: '.gitignore', blobSha: sha, deleted: false, revision: 1 };
    a.t.after['.gitignore'] = sha; a.t.scopeKey = JSON.stringify({ ...JSON.parse(a.t.scopeKey), gitignore: 'cache/' });
    await a.service.transactions.save(a.t);
    const manifest = advance(a); manifest.files.rules = { ...manifest.files.rules!, deleted: true, revision: 2 };
    a.remote.contents()[MANIFEST_PATH] = a.remote.blob(bytes(JSON.stringify(manifest)));
    await a.service.resume(options, 'test');
    expect(a.state.current()).toMatchObject({ baseRemoteCommit: a.remote.head, baseManifest: manifest });
  });
  it.each(['schema', 'generation rollback', 'identity dropped', 'revision rollback', 'tombstone reuse'])('blocks invalid descendant Manifest: %s', async mode => {
    const a = await fixture(); const manifest = advance(a);
    const id = Object.keys(a.t.manifest.files)[0]!;
    if (mode === 'generation rollback') manifest.generation = 0;
    if (mode === 'identity dropped') delete manifest.files[id];
    if (mode === 'revision rollback') manifest.files[id]!.revision = 1;
    if (mode === 'tombstone reuse') {
      a.t.manifest.files.removed = { fileId: 'removed', path: 'removed.md', deleted: true, revision: 2 };
      await a.service.transactions.save(a.t);
      manifest.files.removed = { fileId: 'removed', path: 'removed.md', deleted: false, revision: 3, blobSha: manifest.files[id]!.blobSha! };
    }
    a.remote.contents()[MANIFEST_PATH] = a.remote.blob(bytes(mode === 'schema' ? '{}' : JSON.stringify(manifest)));
    await blocked(a, 'REMOTE_MANIFEST_INVALID');
    await expect(a.service.startFreshPreviewFromCurrentHead(options, 'test')).rejects.toMatchObject({ code: 'REMOTE_MANIFEST_INVALID' });
    expect(await a.service.transactions.active()).not.toBeNull();
  });
  it.each(['diverged', 'equal', 'normal recovery'])('cannot bypass %s through fresh Preview', async mode => {
    const a = await fixture();
    if (mode === 'diverged') a.remote.head = a.t.originalHead;
    if (mode === 'normal recovery') { a.t.createdAt = new Date().toISOString(); await a.service.transactions.save(a.t); }
    const state = a.state.current(); const count = a.remote.calls.length;
    await expect(a.service.startFreshPreviewFromCurrentHead(options, 'test')).rejects.toMatchObject({ code: mode === 'diverged' ? 'LEGACY_RECOVERY_DIVERGED' : 'LEGACY_FRESH_PREVIEW_UNAVAILABLE' });
    expect(a.state.current()).toEqual(state); expect(await a.service.transactions.active()).toEqual(a.t);
    expect(a.remote.calls.slice(count).every(c => c.method === 'GET')).toBe(true);
  });
  it.each(['missing', 'changed'])('retains %s backup and reports a precise reason', async mode => {
    const a = await fixture();
    if (mode === 'missing') a.remote.refs.delete(a.t.backupRef!); else a.remote.refs.set(a.t.backupRef!, a.t.commit);
    await blocked(a, 'LEGACY_BACKUP_UNVERIFIED', a.t.backupRef);
  });
  it.each(['missing', 'invalid', 'different'])('blocks %s remote Manifest', async mode => {
    const a = await fixture();
    if (mode === 'missing') delete a.remote.contents()[MANIFEST_PATH];
    else a.remote.contents()[MANIFEST_PATH] = a.remote.blob(bytes(mode === 'invalid' ? '{}' : JSON.stringify({ ...a.t.manifest, generation: 9 })));
    await blocked(a, mode === 'missing' ? 'LEGACY_MANIFEST_MISSING' : mode === 'invalid' ? 'REMOTE_MANIFEST_INVALID' : 'LEGACY_MANIFEST_MISMATCH');
  });
  it.each(['changed', 'extra', 'missing'])('blocks %s remote tree entries', async mode => {
    const a = await fixture();
    if (mode === 'missing') delete a.remote.contents()['note.md'];
    else a.remote.contents()[mode === 'extra' ? 'extra.md' : 'note.md'] = a.remote.blob(bytes('unexpected'));
    await blocked(a, 'LEGACY_REMOTE_TREE_MISMATCH', mode === 'extra' ? 'extra.md' : 'note.md');
  });
  it('rejects a journal after-map that is not the full Manifest tree', async () => {
    const a = await fixture(); a.t.after = {}; await a.service.transactions.save(a.t);
    await blocked(a, 'LEGACY_TRANSACTION_MISMATCH', 'note.md');
  });
  it('requires current settings to retain the reviewed sync scope', async () => {
    const a = await fixture(); await blocked(a, 'LEGACY_SCOPE_CHANGED', undefined, { ...options, ignorePatterns: '*.md' });
  });
  it('does not silently skip a Manifest identity that is excluded from verification', async () => {
    const a = await fixture(); a.t.excludedPaths = ['note.md']; await a.service.transactions.save(a.t);
    await blocked(a, 'LEGACY_SCOPE_UNVERIFIED', 'note.md');
  });
  it('does not depend on missing legacy recovery blobs once all current bytes match', async () => {
    const a = await fixture();
    for (const path of a.vault.internal.keys()) if (path.includes('/objects/blobs/')) a.vault.internal.delete(path);
    a.vault.apply = async () => { throw new Error('must not replay local writes'); };
    await a.service.resume(options, 'test');
    expect(a.state.current().baseRemoteCommit).toBe(a.t.commit); expect(await a.service.transactions.active()).toBeNull();
  });
  it('reports scanner concurrency without collapsing it to RECOVERY_ENV_CHANGED', async () => {
    const a = await fixture(); const read = a.vault.readBinary.bind(a.vault); let changed = false;
    a.vault.readBinary = async path => {
      const data = await read(path);
      if (path === 'note.md' && !changed) { changed = true; a.vault.files.set(path, bytes('changed during first scan')); }
      return data;
    };
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'LEGACY_LOCAL_MISMATCH' });
    expect(a.state.current().baseManifest).toBeUndefined(); expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('rejects case-colliding published identities even when bytes match', async () => {
    const a = await fixture(); const original = Object.values(a.t.manifest.files)[0]!;
    a.t.manifest.files.other = { ...original, fileId: 'other', path: 'NOTE.md' };
    a.t.after['NOTE.md'] = original.blobSha!; a.remote.contents()['NOTE.md'] = original.blobSha!;
    a.vault.files.set('NOTE.md', bytes('published local'));
    a.remote.contents()[MANIFEST_PATH] = a.remote.blob(bytes(JSON.stringify(a.t.manifest)));
    await a.service.transactions.save(a.t);
    await blocked(a, 'LEGACY_PATH_CONFLICT', 'NOTE.md');
  });
  it('retains tombstones when recovering verified current bytes', async () => {
    const a = await fixture();
    a.t.manifest.files.removed = { fileId: 'removed', path: 'removed.md', deleted: true, revision: 2 };
    a.remote.contents()[MANIFEST_PATH] = a.remote.blob(bytes(JSON.stringify(a.t.manifest)));
    await a.service.transactions.save(a.t); await a.service.resume(options, 'test');
    expect(a.state.current().baseManifest!.files.removed).toEqual(a.t.manifest.files.removed);
  });
  it.each(['offline', 'unsafe mode'])('fails closed on %s remote reads', async mode => {
    const a = await fixture(); const transport = a.remote.transport;
    a.remote.transport = async req => {
      if (mode === 'offline') return { status: 403, json: {} };
      const response = await transport(req);
      if (req.url.includes('/trees/')) {
        const tree = response.json as { tree: { path: string; mode: string }[] };
        tree.tree.find(f => f.path === 'note.md')!.mode = '120000';
      }
      return response;
    };
    await blocked(a, mode === 'offline' ? 'HTTP_403' : 'LEGACY_REMOTE_TREE_MISMATCH');
  });
  it('does not require a backup ref for ordinary legacy transactions that never had one', async () => {
    const a = await fixture(); delete a.t.backupRef; delete a.t.adoptionChoice; await a.service.transactions.save(a.t);
    await a.service.resume(options, 'test'); expect(await a.service.transactions.active()).toBeNull();
  });
  it('rejects another target without reading or writing GitHub', async () => {
    const a = await fixture(); const count = a.remote.calls.length;
    await blocked(a, 'LEGACY_TARGET_MISMATCH', undefined, { ...options, repository: 'different' });
    expect(a.remote.calls).toHaveLength(count);
  });
  it('does not replace an existing unrelated BASE', async () => {
    const a = await fixture(); await a.state.save({ ...a.state.current(), target, baseManifest: { ...a.t.manifest, generation: 20 }, lastSeenGeneration: 20, baseRemoteCommit: a.t.originalHead });
    await blocked(a, 'LEGACY_BASE_MISMATCH');
  });
  it('does not weaken V1.1 device validation', async () => {
    const a = await fixture(); a.t.createdAt = new Date().toISOString(); await a.service.transactions.save(a.t);
    await blocked(a, 'RECOVERY_ENV_CHANGED');
  });
  it('reports a transaction changed since review without a generic environment error', async () => {
    const a = await fixture(); const reviewed = structuredClone(a.t);
    a.t.phase = 'verified'; await a.service.transactions.save(a.t);
    await expect(a.service.resume(options, 'test', () => {}, reviewed)).rejects.toMatchObject({ code: 'LEGACY_TRANSACTION_CHANGED' });
    expect(a.state.current().baseManifest).toBeUndefined(); expect(await a.service.transactions.active()).toEqual(a.t);
  });
  it('does not treat V1.1 observation journals without createdAt as V1.0', async () => {
    const a = await fixture(); a.t.observation = a.product.prepare(a.t, []); await a.service.transactions.save(a.t);
    await blocked(a, 'RECOVERY_ENV_CHANGED');
  });
  it('still forbids aborting legacy published transactions', async () => {
    const a = await fixture(); await expect(a.service.abortTransaction(options, 'test')).rejects.toMatchObject({ code: 'ALREADY_PUBLISHED' });
    expect(await a.service.transactions.active()).toEqual(a.t);
  });
  it.each(['head', 'local', 'state', 'journal'])('fails closed if %s changes during verification', async mode => {
    const a = await fixture(); const transport = a.remote.transport; let changed = false;
    a.remote.transport = async req => {
      const response = await transport(req);
      if (!changed && req.url.includes('/blobs/')) {
        changed = true;
        if (mode === 'head') a.remote.external({ 'other.md': 'advanced' });
        if (mode === 'local') a.vault.files.set('note.md', bytes('concurrent edit'));
        if (mode === 'state') await a.state.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
        if (mode === 'journal') { a.t.phase = 'applying'; await a.service.transactions.save(a.t); }
      }
      return response;
    };
    await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: {
      head: 'REMOTE_ADVANCED_SINCE_LEGACY_TRANSACTION', local: 'LEGACY_LOCAL_MISMATCH', state: 'LEGACY_STATE_CHANGED', journal: 'LEGACY_TRANSACTION_CHANGED',
    }[mode] });
    expect(a.state.current().baseManifest).toBeUndefined(); expect(await a.service.transactions.active()).not.toBeNull(); expect(a.vault.mutations).toEqual([]);
  });
  it.each(['state', 'observer', 'complete journal', 'clear pointer'])('can retry a failed %s checkpoint after reload', async checkpoint => {
    const a = await fixture(); const originalWrite = a.vault.writeInternal.bind(a.vault); let failed = false;
    a.vault.writeInternal = async (path, value) => {
      if (!failed && (checkpoint === 'state' && path === 'state'
        || checkpoint === 'observer' && path === 'product/product-state.json'
        || checkpoint === 'complete journal' && path.endsWith('/journal.json') && JSON.parse(JSON.parse(value).payload).phase === 'complete'
        || checkpoint === 'clear pointer' && path.endsWith('/active.json') && value === 'null')) { failed = true; throw new Error('disk full'); }
      await originalWrite(path, value);
    };
    await expect(a.service.resume(options, 'test')).rejects.toThrow();
    expect(failed).toBe(true); expect(await a.service.transactions.active()).not.toBeNull();
    await a.state.load();
    await a.service.resume(options, 'test');
    expect(await a.service.transactions.active()).toBeNull(); expect(a.state.current().baseRemoteCommit).toBe(a.t.commit); expect(a.vault.mutations).toEqual([]);
  });
});
