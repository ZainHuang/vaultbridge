import { describe, expect, it } from 'vitest';
import { safeError } from '../src/errors';
import { GitHubClient, validateTarget } from '../src/github/GitHubClient';
import { RemoteTreeReader } from '../src/github/RemoteTreeReader';
import type { GetRequest, GetTransport } from '../src/github/types';
import { PreviewService } from '../src/sync/PreviewService';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { TokenStore } from '../src/settings/TokenStore';
import { bytes, HEAD, MemoryVault, referenceSha, remoteTransport, SUBTREE, target, TREE, treeEntries } from './helpers';

const options = { ...DEFAULT_SETTINGS, ...target };

describe('RemoteTreeReader', () => {
  it('reads ref, commit, recursive tree using GET only and pins HEAD', async () => {
    const calls: GetRequest[] = [];
    const result = await new RemoteTreeReader(new GitHubClient(target, 'test-token', remoteTransport(treeEntries({ 'a.md': bytes('a') }), calls))).read('main');
    expect(result.remoteHeadSha).toBe(HEAD); expect(result.treeSha).toBe(TREE);
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.method === 'GET' && call.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(calls[0]?.headers.Authorization).toBe('Bearer test-token');
    expect(calls[0]?.headers['User-Agent']).toBe('Local-Mirror-Sync/0.1.5');
  });
  it('replaces a truncated response with complete subtree traversal', async () => {
    const calls: string[] = [];
    const base = remoteTransport([]);
    const transport: GetTransport = async request => {
      calls.push(request.url);
      if (!request.url.includes('/trees/')) return base(request);
      if (request.url.includes('?')) return { status: 200, json: { sha: TREE, tree: [], truncated: true } };
      if (request.url.endsWith(TREE)) return { status: 200, json: { sha: TREE, truncated: false, tree: [
        { path: 'one', type: 'tree', mode: '040000', sha: SUBTREE }, { path: 'two', type: 'tree', mode: '040000', sha: SUBTREE },
      ] } };
      return { status: 200, json: { sha: SUBTREE, truncated: false, tree: treeEntries({ 'a.md': bytes('a') }) } };
    };
    const result = await new RemoteTreeReader(new GitHubClient(target, '', transport)).read('main');
    expect(result.entries.map(entry => entry.path)).toEqual(['one', 'one/a.md', 'two', 'two/a.md']);
    expect(calls.filter(url => url.endsWith(SUBTREE))).toHaveLength(1);
    expect(calls.filter(url => url.includes('/trees/') && !url.includes('?')).every(url => !url.includes('recursive'))).toBe(true);
  });
  it('rejects truncated shallow tree', async () => {
    const base = remoteTransport([]);
    const transport: GetTransport = async request => request.url.includes('/trees/')
      ? { status: 200, json: { sha: TREE, tree: [], truncated: true } } : base(request);
    await expect(new RemoteTreeReader(new GitHubClient(target, '', transport)).read('main')).rejects.toMatchObject({ code: 'TRUNCATED_TREE' });
  });
  it.each([{}, { sha: TREE, tree: [] }, { sha: TREE, tree: [{ path: 'x', type: 'blob', mode: '100644', sha: HEAD }], truncated: false },
    { sha: TREE, tree: [{ path: 'nested/a.md', type: 'blob', mode: '100644', sha: HEAD, size: 1 }], truncated: false },
    { sha: HEAD, tree: [], truncated: false },
  ])('fails closed for malformed/incomplete tree case %#', async response => {
    const base = remoteTransport([]);
    const transport: GetTransport = async request => request.url.includes('/trees/') ? { status: 200, json: response } : base(request);
    await expect(new RemoteTreeReader(new GitHubClient(target, '', transport)).read('main')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([401, 403, 404, 409, 429, 500])('reports HTTP %i without treating an error as an empty tree', async status => {
    const reader = new RemoteTreeReader(new GitHubClient(target, 'secret', async () => ({ status, json: { message: 'secret' } })));
    await expect(reader.read('main')).rejects.toMatchObject({ code: `HTTP_${status}`, stage: 'REMOTE_REF' });
    try { await reader.read('main'); } catch (error) { expect(safeError(error)).not.toContain('secret'); }
  });
  it('preserves Unicode / slash branch names in encoded route segments', async () => {
    const branch = 'notes/中文'; const calls: string[] = [];
    const base = remoteTransport([]);
    const transport: GetTransport = async request => {
      calls.push(request.url);
      return request.url.includes('/ref/') ? { status: 200, json: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: HEAD } } } : base(request);
    };
    await new RemoteTreeReader(new GitHubClient({ ...target, branch }, '', transport)).read(branch);
    expect(calls[0]).toContain('ref/heads/notes/%E4%B8%AD%E6%96%87');
  });
  it.each(['../bad', 'main?token=x', 'a.lock', '/main', 'a//b', 'a b'])('rejects branch %s before any network request', branch => {
    expect(() => validateTarget({ ...target, branch })).toThrow();
  });
});

describe('Full read-only Preview', () => {
  it('re-hashes both passes and reports remote-only delete while leaving both stores unchanged', async () => {
    const vault = new MemoryVault({ 'a.md': 'after', '.gitignore': '*.mp3', 'audio.mp3': [0, 1, 255], 'image.png': [137, 80, 0, 255] });
    const remote = treeEntries({ 'a.md': bytes('before'), '.gitignore': bytes('*.mp3'), 'legacy.md': bytes('legacy') });
    const before = [...vault.files].map(([path, value]) => [path, referenceSha(value)]);
    const remoteBefore = JSON.stringify(remote); const calls: GetRequest[] = [];
    const result = await new PreviewService(vault, remoteTransport(remote, calls), '.obsidian').preview(options, 'secret');
    expect(result.plan.counts).toEqual({ ADD: 1, UPDATE: 1, DELETE: 1, RENAME: 0, UNCHANGED: 1, IGNORED: 1, CONFLICT: 0 });
    expect(result.executionAllowed).toBe(false);
    expect(vault.reads.filter(path => path === 'a.md')).toHaveLength(2);
    expect([...vault.files].map(([path, value]) => [path, referenceSha(value)])).toEqual(before);
    expect(JSON.stringify(remote)).toBe(remoteBefore);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each(['same-size bytes', 'new file', 'ignore rules'])('detects %s changes during remote reads', async change => {
    const vault = new MemoryVault({ 'a.md': 'before', '.gitignore': '*.mp3' });
    const base = remoteTransport([]);
    const transport: GetTransport = async request => {
      if (request.url.includes('/ref/')) {
        if (change === 'same-size bytes') vault.files.set('a.md', bytes('AFTER!'));
        if (change === 'new file') vault.files.set('new.md', bytes('new'));
        if (change === 'ignore rules') vault.files.set('.gitignore', bytes('*.wav'));
      }
      return base(request);
    };
    await expect(new PreviewService(vault, transport, '.obsidian').preview(options, '')).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
  });
  it('network failure can be explicitly retried with a fresh scan and without writes', async () => {
    const vault = new MemoryVault({ 'a.md': 'A' });
    let failed = false;
    const base = remoteTransport([]);
    const transport: GetTransport = async request => {
      if (!failed && request.url.includes('/trees/')) { failed = true; throw new Error('Authorization: secret'); }
      return base(request);
    };
    const service = new PreviewService(vault, transport, '.obsidian');
    await expect(service.preview(options, 'secret')).rejects.toMatchObject({ code: 'NETWORK_ERROR', stage: 'REMOTE_TREE' });
    expect((await service.preview(options, 'secret')).plan.counts.ADD).toBe(1);
    expect(vault.reads.filter(path => path === 'a.md')).toHaveLength(3);
  });
  it('rejects unreadable .gitignore before network', async () => {
    const vault = new MemoryVault({ '.gitignore': [255, 255] }); let requests = 0;
    await expect(new PreviewService(vault, async () => { requests++; return { status: 200, json: {} }; }, '.obsidian').preview(options, '')).rejects.toMatchObject({ stage: 'IGNORE' });
    expect(requests).toBe(0);
  });
});

describe('Token boundaries', () => {
  it('prefers SecretStorage and writes no token into serializable settings', () => {
    const secrets = new Map<string, string>();
    const store = new TokenStore({ getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => { secrets.set(key, value); } });
    const saved = store.withToken(DEFAULT_SETTINGS, 'private-token');
    expect(saved.localToken).toBe(''); expect(saved.secretName).toMatch(/^local-mirror-sync-/);
    expect(JSON.stringify(saved)).not.toContain('private-token');
    expect(store.read(saved)).toBe('private-token');
  });
  it('uses local fallback only when SecretStorage is absent', () => {
    const store = new TokenStore();
    const saved = store.withToken(DEFAULT_SETTINGS, 'private-token');
    expect(store.read(saved)).toBe('private-token');
    expect(() => store.read({ ...saved, secretName: 'missing-key' })).toThrow(/unavailable/);
    expect(() => new TokenStore({ getSecret: () => null, setSecret: () => { throw new Error('secret'); } }).withToken(DEFAULT_SETTINGS, 'private-token')).toThrow(/could not save/);
  });
});
