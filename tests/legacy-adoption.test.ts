import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { previewGroups } from '../src/ui/PreviewModel';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';
import { gitBlobSha } from '../src/vault/HashService';

const options = { ...target, includeObsidian: false, ignorePatterns: '*.log', deleteSafetyThreshold: 0 };
const localFiles = { 'local.md': 'local only', 'same.md': 'same', 'changed.md': 'local version', '图.png': '\0local binary' };
const remoteFiles = { 'remote.md': 'remote only', 'same.md': 'same', 'changed.md': 'remote version', '图.png': '\0remote binary' };
async function fixture(local: Record<string, string> = localFiles, files: Record<string, string> = remoteFiles) {
  const remote = new GitFixture(files); const vault = new WritableVault(local);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const service = new SyncService(vault, request => remote.transport(request), '.obsidian', state);
  const preview = () => service.preview(options, 'fixture');
  return { remote, vault, state, service, preview };
}
const localContents = (vault: WritableVault) => Object.fromEntries([...vault.files].filter(([p]) => !p.startsWith('.') && !p.endsWith('.log')).map(([p, b]) => [p, new TextDecoder().decode(b)]));
const remoteContents = (remote: GitFixture) => Object.fromEntries(Object.keys(remote.contents()).filter(p => !p.startsWith('.') && !p.endsWith('.log')).map(p => [p, remote.text(p)]));

describe('Legacy adoption explicit authority', () => {
  it('requires a side choice and counts only actual file conflicts', async () => {
    const a = await fixture(); const p = await a.preview();
    expect(p.mode).toBe('ADOPT'); expect(p.canExecute).toBe(false);
    expect(previewGroups(p.plan).Conflict).toBe(p.plan.entries.filter(e => e.category.startsWith('CONFLICT_')).length);
    await expect(a.service.execute(p, 'fixture')).rejects.toThrow();
    expect(a.remote.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('also blocks unselected adoption when the sides have no file conflicts', async () => {
    const a = await fixture({ 'L.md': 'local' }, { 'R.md': 'remote' });
    const p = await a.preview(); expect(previewGroups(p.plan).Conflict).toBe(0); expect(p.canExecute).toBe(false);
    await expect(a.service.execute(p, 'fixture')).rejects.toThrow();
  });
  for (const side of ['local', 'remote'] as const) {
    const phrase = `USE ${side.toUpperCase()}`;
    it(`${phrase} mirrors exactly, publishes generation 1 atomically, backs up first and enters three-way sync`, async () => {
      const a = await fixture(); const head = a.remote.head;
      const p = a.service.selectAdoption(await a.preview(), side);
      expect(p.adoptionChoice).toBe(side); expect(p.canExecute).toBe(true);
      expect(p.plan.hasConflicts).toBe(false); expect(previewGroups(p.plan).Conflict).toBe(0);
      expect(p.plan.counts[side === 'local' ? 'PUSH_DELETE' : 'PULL_DELETE']).toBe(1);
      const transport = a.remote.transport;
      a.remote.transport = async req => {
        if (req.method === 'PATCH') {
          expect([...a.remote.refs.values()]).toContain(head);
          const t = (await a.service.transactions.active())!;
          for (const value of Object.values(localFiles)) expect(await a.service.transactions.blob(t.id, gitBlobSha(bytes(value)))).toEqual(bytes(value));
          expect(a.vault.mutations).toEqual([]);
        }
        return transport(req);
      };
      await a.service.execute(p, 'fixture', () => {}, undefined, phrase);
      a.remote.transport = transport;
      const desired = side === 'local' ? localFiles : remoteFiles;
      expect(remoteContents(a.remote)).toEqual(desired); expect(localContents(a.vault)).toEqual(desired);
      const manifest = JSON.parse(a.remote.text(MANIFEST_PATH));
      expect(manifest.generation).toBe(1); expect(a.state.current().baseManifest).toEqual(manifest);
      expect(Object.values(manifest.files)).toHaveLength(Object.keys(desired).length);
      expect(Object.values(manifest.files)).toEqual(expect.arrayContaining(Object.keys(desired).map(path => expect.objectContaining({ path, deleted: false, revision: 1 }))));
      const treeCalls = a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'trees');
      expect(treeCalls).toHaveLength(1); expect(treeCalls[0]!.body!.tree).toEqual(expect.arrayContaining([expect.objectContaining({ path: MANIFEST_PATH })]));
      expect(a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
      const next = await a.preview(); expect(next.mode).toBe('SYNC'); expect(next.adoptionChoice).toBeUndefined();
      expect(() => a.service.selectAdoption(next, side)).toThrow();
      // A new disagreement after adoption must still be a three-way conflict.
      a.vault.files.set('changed.md', bytes('local after adoption'));
      const other = await fixture({} as typeof localFiles, {} as typeof remoteFiles);
      const b = new SyncService(other.vault, a.remote.transport, '.obsidian', other.state);
      await b.execute(await b.preview(options, 'fixture'), 'fixture');
      other.vault.files.set('changed.md', bytes('remote after adoption'));
      await b.execute(await b.preview(options, 'fixture'), 'fixture');
      const conflict = await a.preview(); expect(conflict.plan.counts.CONFLICT_CONTENT).toBe(1); expect(conflict.canExecute).toBe(false);
    });
    it(`${phrase} requires exact confirmation and ignores mutable display fields`, async () => {
      const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), side);
      p.adoptionChoice = side === 'local' ? 'remote' : 'local'; p.canExecute = true;
      for (const confirmation of ['', phrase.toLowerCase(), `${phrase} `, 'DELETE 1', side === 'local' ? 'USE REMOTE' : 'USE LOCAL']) {
        await expect(a.service.execute(p, 'fixture', () => {}, undefined, confirmation)).rejects.toThrow(phrase);
      }
      expect(a.remote.calls.every(c => c.method === 'GET')).toBe(true); expect(a.vault.mutations).toEqual([]);
    });
    it(`${phrase} preserves ignored and protected bytes and excludes them from the manifest`, async () => {
      const extras = { 'skip.log': 'local ignored', '.obsidian/plugins/local-mirror-sync/data.json': 'local secret', '.local-mirror-sync/other': 'local internal' };
      const remoteExtras = Object.fromEntries(Object.keys(extras).map(p => [p, 'remote ignored']));
      const a = await fixture({ ...localFiles, ...extras }, { ...remoteFiles, ...remoteExtras });
      await a.service.execute(a.service.selectAdoption(await a.preview(), side), 'fixture', () => {}, undefined, phrase);
      for (const [path, value] of Object.entries(extras)) { expect(a.vault.files.get(path)).toEqual(bytes(value)); expect(a.remote.text(path)).toBe('remote ignored'); }
      expect(Object.values(a.state.current().baseManifest!.files).some(f => f.path in extras)).toBe(false);
    });
    for (const change of ['edit', 'add', 'delete', 'ignore', 'head'] as const) it(`${phrase} blocks stale ${change} before mutations`, async () => {
      const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), side);
      if (change === 'edit') a.vault.files.set('changed.md', bytes('concurrent'));
      if (change === 'add') a.vault.files.set('concurrent.md', bytes('new'));
      if (change === 'delete') a.vault.files.delete('local.md');
      if (change === 'ignore') a.vault.files.set('.gitignore', bytes('*.png'));
      if (change === 'head') a.remote.external(remoteFiles); // Same bytes, new HEAD still invalidates Preview.
      await expect(a.service.execute(p, 'fixture', () => {}, undefined, phrase)).rejects.toThrow();
      expect(a.remote.calls.every(c => c.method === 'GET')).toBe(true); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
    });
    it(`${phrase} blocks a remote writer at publication`, async () => {
      const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), side);
      a.remote.beforePatch = () => a.remote.external({ 'race.md': 'keep race' });
      await expect(a.service.execute(p, 'fixture', () => {}, undefined, phrase)).rejects.toThrow();
      expect(a.remote.text('race.md')).toBe('keep race'); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
    });
    it(`${phrase} retains journal and BASE on failed local Verify`, async () => {
      const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), side);
      await expect(a.service.execute(p, 'fixture', message => {
        if (message === 'Verifying local bytes before saving BASE') a.vault.files.set('concurrent.md', bytes('late writer'));
      }, undefined, phrase)).rejects.toThrow();
      expect(a.state.current().baseManifest).toBeUndefined(); expect(await a.service.transactions.active()).not.toBeNull();
    });
    it(`${phrase} rejects extra remote files during Verify`, async () => {
      const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), side);
      await expect(a.service.execute(p, 'fixture', message => {
        if (message === 'Verifying immutable remote commit and manifest') a.remote.contents()['extra.md'] = a.remote.blob(bytes('unexpected'));
      }, undefined, phrase)).rejects.toThrow();
      expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
    });
    it(`${phrase} resumes a lost publish response without a second commit`, async () => {
      const a = await fixture(); a.remote.losePatchResponse = true;
      await expect(a.service.execute(a.service.selectAdoption(await a.preview(), side), 'fixture', () => {}, undefined, phrase)).rejects.toThrow();
      expect(a.state.current().baseManifest).toBeUndefined();
      await a.service.resume(options, 'fixture'); expect(a.state.current().baseManifest?.generation).toBe(1);
      expect(a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
    });
    it(`${phrase} blocks local additions during publication before applying any files`, async () => {
      const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), side);
      a.remote.beforePatch = () => a.vault.files.set('during-publish.md', bytes('keep'));
      await expect(a.service.execute(p, 'fixture', () => {}, undefined, phrase)).rejects.toThrow();
      expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
    });
    it(`${phrase} does not accept a descendant HEAD during recovery`, async () => {
      const a = await fixture(); a.remote.losePatchResponse = true;
      await expect(a.service.execute(a.service.selectAdoption(await a.preview(), side), 'fixture', () => {}, undefined, phrase)).rejects.toThrow();
      a.remote.external(Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)])));
      await expect(a.service.resume(options, 'fixture')).rejects.toThrow(); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
    });
    it(`${phrase} protects internal files even with negated ignore patterns`, async () => {
      const a = await fixture({ ...localFiles, '.local-mirror-sync/private': 'secret' }, { ...remoteFiles, '.obsidian/plugins/local-mirror-sync/data.json': 'private' });
      const p = await a.service.preview({ ...options, includeObsidian: true, ignorePatterns: '!**' }, 'fixture');
      await a.service.execute(a.service.selectAdoption(p, side), 'fixture', () => {}, undefined, phrase);
      expect(Object.values(a.state.current().baseManifest!.files).some(f => f.path.startsWith('.'))).toBe(false);
    });
  }
  it('recovers a partial Use Remote that has already replaced .gitignore', async () => {
    const a = await fixture({ '.gitignore': '*.tmp', 'z.md': 'local' }, { '.gitignore': '*.log', 'z.md': 'remote' });
    a.vault.failPath = 'z.md';
    await expect(a.service.execute(a.service.selectAdoption(await a.preview(), 'remote'), 'fixture', () => {}, undefined, 'USE REMOTE')).rejects.toThrow();
    expect(a.vault.files.get('.gitignore')).toEqual(bytes('*.log')); expect(a.state.current().baseManifest).toBeUndefined();
    a.vault.failPath = undefined;
    await a.service.resume(options, 'fixture'); expect(a.state.current().baseManifest?.generation).toBe(1);
    expect(a.vault.files.get('z.md')).toEqual(bytes('remote'));
  });
  it('rechecks recovery bytes on resume before any local removal', async () => {
    const a = await fixture(); a.remote.losePatchResponse = true;
    await expect(a.service.execute(a.service.selectAdoption(await a.preview(), 'remote'), 'fixture', () => {}, undefined, 'USE REMOTE')).rejects.toThrow();
    for (const path of a.vault.internal.keys()) if (path.endsWith(gitBlobSha(bytes(localFiles['local.md'])))) a.vault.internal.set(path, btoa('damaged'));
    await expect(a.service.resume(options, 'fixture')).rejects.toThrow(); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it.each(['reject', 'wrong-readback'])('fails closed when GitHub backup ref %s', async failure => {
    const a = await fixture(); const transport = a.remote.transport;
    a.remote.transport = async req => {
      if (failure === 'reject' && req.method === 'POST' && req.url.endsWith('/refs')) return { status: 403, json: {} };
      const result = await transport(req);
      if (failure === 'wrong-readback' && req.method === 'GET' && req.url.includes('/ref/heads/local-mirror-sync-backup/')) return { status: 200, json: { ref: 'wrong', object: { sha: a.remote.head, type: 'commit' } } };
      return result;
    };
    const head = a.remote.head;
    await expect(a.service.execute(a.service.selectAdoption(await a.preview(), 'local'), 'fixture', () => {}, undefined, 'USE LOCAL')).rejects.toThrow();
    expect(a.remote.head).toBe(head); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
    expect(a.remote.calls.some(c => c.method === 'POST' && c.resource === 'trees')).toBe(false);
  });
  it('fails before local changes when recovery storage cannot be read back', async () => {
    const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), 'remote');
    a.vault.writeInternal = async () => {};
    await expect(a.service.execute(p, 'fixture', () => {}, undefined, 'USE REMOTE')).rejects.toThrow();
    expect(a.remote.calls.every(c => c.method === 'GET')).toBe(true); expect(a.vault.mutations).toEqual([]); expect(a.state.current().baseManifest).toBeUndefined();
  });
  it('cannot bypass a stale local Preview through recovery of an unpublished commit', async () => {
    const a = await fixture(); const p = a.service.selectAdoption(await a.preview(), 'remote'); const head = a.remote.head;
    const transport = a.remote.transport;
    a.remote.transport = async req => {
      const result = await transport(req);
      if (req.method === 'POST' && req.url.endsWith('/commits')) a.vault.files.set('changed.md', bytes('concurrent edit'));
      return result;
    };
    await expect(a.service.execute(p, 'fixture', () => {}, undefined, 'USE REMOTE')).rejects.toThrow();
    await expect(a.service.resume(options, 'fixture')).rejects.toThrow(); expect(a.remote.head).toBe(head); expect(a.vault.mutations).toEqual([]);
  });
  it('keeps Windows path collisions blocked after choosing an authority', async () => {
    const a = await fixture({ ...localFiles, 'Case.md': 'one' }, { ...remoteFiles, 'case.md': 'two' });
    for (const side of ['local', 'remote'] as const) { const p = a.service.selectAdoption(await a.preview(), side); expect(p.canExecute).toBe(false); }
  });
  it('forbids global authority choices during initialize, bootstrap, attach or missing-manifest recovery', async () => {
    const a = await fixture(localFiles, {} as typeof remoteFiles);
    const initial = await a.preview(); expect(() => a.service.selectAdoption(initial, 'remote')).toThrow();
    await a.service.execute(initial, 'fixture');
    const b = await fixture({} as typeof localFiles); const other = new SyncService(b.vault, a.remote.transport, '.obsidian', b.state);
    const bootstrap = await other.preview(options, 'fixture'); expect(() => other.selectAdoption(bootstrap, 'local')).toThrow();
    b.vault.files.set('local.md', bytes('different')); const attach = await other.preview(options, 'fixture'); expect(() => other.selectAdoption(attach, 'remote')).toThrow();
    a.remote.external(remoteFiles); expect(() => a.service.selectAdoption(initial, 'local')).toThrow();
    const missing = await a.preview(); expect(() => a.service.selectAdoption(missing, 'local')).toThrow();
  });
});
