import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import type { GitTransport } from '../src/github/types';
import { GitHubWriter } from '../src/github/GitHubWriter';
import { target } from './helpers';
import { GitFixture, WritableVault } from './v1-harness';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
async function setup() {
  const remote = new GitFixture(); const vault = new WritableVault({ 'note.md': 'initial' });
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) }); await state.load();
  const service = new SyncService(vault, r => remote.transport(r), '.obsidian', state);
  return { remote, vault, state, service, sync: async () => service.execute(await service.preview(options, 'test'), 'test') };
}
const writes = (remote: GitFixture) => remote.calls.filter(c => c.method !== 'GET');

describe('Publish confirmation and fresh mutable refs', () => {
  it('retains a token-free publish timeline in the completed journal', async () => {
    const a = await setup(); const oldHead = a.remote.head; await a.sync();
    const raw = [...a.vault.internal].find(([p]) => p.endsWith('/journal.json'))![1];
    const t = JSON.parse(JSON.parse(raw).payload);
    expect(t.publication?.treeSha).toBe(a.remote.commits.get(t.commit)?.tree);
    expect(t.publication?.events.map((e: { kind: string }) => e.kind)).toEqual(['commit-created', 'patch-request', 'patch-response', 'read-back']);
    expect(t.publication.events[0]).toMatchObject({ commit: t.commit });
    expect(t.publication.events[1]).toMatchObject({ expectedHead: oldHead, commit: t.commit, ref: 'refs/heads/main', force: false });
    expect(t.publication.events[2]).toMatchObject({ status: 200, commit: t.commit, ref: 'refs/heads/main' });
    expect(t.publication.events[3]).toMatchObject({ head: t.commit });
    expect(t.publication.events.every((e: { at: string }) => Number.isFinite(Date.parse(e.at)))).toBe(true);
    expect(raw).not.toMatch(/Authorization|Bearer|fixture-token/);
  });

  it('single-device first Sync ignores a fresh HTTP cache entry for the pre-PATCH GET ref', async () => {
    const a = await setup(); const transport = a.remote.transport;
    const cache = new Map<string, Awaited<ReturnType<GitTransport>>>();
    a.remote.transport = async r => {
      // GET git/ref/... and PATCH git/refs/... are different cache keys.
      if (r.method === 'GET' && r.url.includes('/ref/')) {
        if (!/no-cache/.test(r.headers['Cache-Control'] ?? '') && cache.has(r.url)) return cache.get(r.url)!;
        const result = await transport(r); cache.set(r.url, structuredClone(result)); return result;
      }
      return transport(r);
    };
    await a.sync();
    expect(await a.service.transactions.active()).toBeNull();
    expect(a.state.current().baseRemoteCommit).toBe(a.remote.head);
    expect(a.remote.text('note.md')).toBe('initial');
    expect(writes(a.remote).filter(c => c.resource === 'commits')).toHaveLength(1);
    expect(writes(a.remote).filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('does not persist published until PATCH response and matching read-back complete', async () => {
    const a = await setup(); const transport = a.remote.transport;
    const trace: string[] = []; let patched = false;
    a.remote.transport = async r => {
      const result = await transport(r);
      if (r.method === 'POST' && r.url.endsWith('/commits')) {
        trace.push('commit'); expect((await a.service.transactions.active())?.phase).toBe('prepared');
      }
      if (r.method === 'PATCH') { patched = true; trace.push('patch'); }
      else if (patched && r.url.endsWith('/ref/heads/main') && !trace.includes('read-back')) {
        expect((await a.service.transactions.active())?.phase).toBe('prepared'); trace.push('read-back');
      }
      return result;
    };
    const save = a.service.transactions.save.bind(a.service.transactions);
    vi.spyOn(a.service.transactions, 'save').mockImplementation(async t => { if (t.phase === 'published') trace.push('published'); await save(t); });
    await a.sync();
    expect(trace.slice(0, 4)).toEqual(['commit', 'patch', 'read-back', 'published']);
    const commitCall = a.remote.calls.find(c => c.resource === 'commits' && c.method === 'POST')!;
    expect(commitCall.body?.tree).toBe(a.remote.commits.get(a.remote.head)?.tree);
  });

  it.each(['HTTP failure', 'timeout before update', 'lost response', 'invalid response', 'wrong response SHA', 'read-back failure', 'read-back old HEAD'] as const)('%s retains prepared and resumes the same candidate once', async fault => {
    const a = await setup(); const oldHead = a.remote.head; const transport = a.remote.transport;
    let patched = false;
    a.remote.transport = async r => {
      if (r.method === 'PATCH') {
        if (fault === 'HTTP failure') return { status: 422, json: {} };
        if (fault === 'timeout before update') throw Error('timeout');
        const result = await transport(r); patched = true;
        if (fault === 'lost response') throw Error('response lost');
        if (fault === 'invalid response') return { status: 200, json: {} };
        if (fault === 'wrong response SHA') return { status: 200, json: { ref: 'refs/heads/main', object: { type: 'commit', sha: oldHead } } };
        return result;
      }
      if (patched && r.url.endsWith('/ref/heads/main')) {
        if (fault === 'read-back failure') throw Error('offline');
        if (fault === 'read-back old HEAD') return { status: 200, json: { ref: 'refs/heads/main', object: { type: 'commit', sha: oldHead } } };
      }
      return transport(r);
    };
    await expect(a.sync()).rejects.toThrow();
    const t = (await a.service.transactions.active())!;
    expect(t.phase).toBe('prepared'); expect(t.commit).not.toBe(oldHead);
    expect(a.state.current().baseManifest).toBeUndefined();
    expect(a.vault.mutations).toEqual([]);
    const calls = a.remote.calls.length;
    a.remote.transport = transport;
    const restarted = new SyncService(a.vault, r => a.remote.transport(r), '.obsidian', a.state);
    const phases: string[] = []; const save = restarted.transactions.save.bind(restarted.transactions);
    vi.spyOn(restarted.transactions, 'save').mockImplementation(async value => { phases.push(value.phase); await save(value); });
    await restarted.resume(options, 'test');
    expect(phases.filter(p => p !== 'prepared')[0]).toBe('published');
    expect(await restarted.transactions.active()).toBeNull();
    expect(a.state.current().baseRemoteCommit).toBe(t.commit); expect(a.remote.head).toBe(t.commit);
    expect(a.remote.calls.slice(calls).filter(c => c.method === 'POST')).toHaveLength(0);
    expect(a.remote.calls.slice(calls).filter(c => c.method === 'PATCH')).toHaveLength(patched ? 0 : 1);
    expect(writes(a.remote).filter(c => c.resource === 'commits')).toHaveLength(1);
    expect(a.remote.calls.some(c => c.body?.force === true)).toBe(false);
  });

  it('repeated recovery read failures never publish again or advance BASE', async () => {
    const a = await setup(); a.remote.losePatchResponse = true;
    await expect(a.sync()).rejects.toThrow(); const t = (await a.service.transactions.active())!;
    const transport = a.remote.transport; const before = writes(a.remote).length;
    a.remote.transport = async () => { throw Error('offline'); };
    await expect(a.service.resume(options, 'test')).rejects.toThrow();
    expect((await a.service.transactions.active())?.phase).toBe('prepared');
    expect(a.state.current().baseManifest).toBeUndefined(); expect(writes(a.remote)).toHaveLength(before);
    a.remote.transport = transport; await a.service.resume(options, 'test');
    expect(a.state.current().baseRemoteCommit).toBe(t.commit); expect(writes(a.remote)).toHaveLength(before);
  });

  it('existing pinned-ancestor Recovery does not create a published checkpoint from ancestry alone', async () => {
    const a = await setup(); a.remote.losePatchResponse = true; await expect(a.sync()).rejects.toThrow();
    a.remote.external({ 'note.md': 'later' }); const count = writes(a.remote).length;
    const phases: string[] = []; const save = a.service.transactions.save.bind(a.service.transactions);
    vi.spyOn(a.service.transactions, 'save').mockImplementation(async t => { phases.push(t.phase); await save(t); });
    await a.service.resume(options, 'test');
    expect(phases).not.toContain('published'); expect(phases).toContain('verified'); expect(writes(a.remote)).toHaveLength(count);
  });

  it('published historical journals finish with fresh HEAD and no second PATCH', async () => {
    const a = await setup(); a.remote.losePatchResponse = true; await expect(a.sync()).rejects.toThrow();
    const t = (await a.service.transactions.active())!; t.phase = 'published'; await a.service.transactions.save(t);
    const count = writes(a.remote).length; await a.service.resume(options, 'test');
    expect(await a.service.transactions.active()).toBeNull(); expect(writes(a.remote)).toHaveLength(count);
  });

  it('read-only Sync uses the existing HEAD without creating an artificial commit', async () => {
    const a = await setup(); await a.sync(); const count = writes(a.remote).length;
    await a.sync(); expect(writes(a.remote)).toHaveLength(count); expect(await a.service.transactions.active()).toBeNull();
  });

  it('checks response ref/type and reads back the configured branch', async () => {
    const remote = new GitFixture(); const oldHead = remote.head;
    remote.external({ 'note.md': 'new' }); const commit = remote.head; remote.head = oldHead;
    const seen: string[] = [];
    const writer = new GitHubWriter(target, 'test', async r => { seen.push(`${r.method} ${r.url.split('/git/')[1]}`); return remote.transport(r); });
    await writer.publish(commit, oldHead);
    expect(seen).toEqual(['GET ref/heads/main', 'PATCH refs/heads/main', 'GET ref/heads/main']);
    expect(remote.head).toBe(commit);
  });
});
