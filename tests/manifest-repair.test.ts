import { describe, expect, it } from 'vitest';
import { GitHubWriter } from '../src/github/GitHubWriter';
import { ManifestRepairService } from '../src/sync/manifest/ManifestRepairService';
import { auditRemoteManifest } from '../src/sync/manifest/RemoteManifestAudit';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import { manifestOf, version, ignore } from './stateful-helpers';
import { bytes, referenceSha, target } from './helpers';
import { GitFixture, WritableVault } from './v1-harness';
const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
function fixture() {
  const old = manifestOf({ ...version(), blobSha: referenceSha(bytes('original')) });
  const remote = new GitFixture({ 'A.md': 'original' });
  remote.external({ 'A.md': 'original', [MANIFEST_PATH]: JSON.stringify(old), '.obsidian/config.json': 'protected' });
  const origin = remote.head;
  remote.external({ 'A.md': 'external edit', [MANIFEST_PATH]: JSON.stringify(old), '.obsidian/config.json': 'protected' });
  const head = remote.head;
  let saved: string | null = null;
  const journal = { read: async () => saved, write: async (text: string) => { saved = text; } };
  const github = new GitHubWriter(target, 'fixture', request => remote.transport(request));
  return { old, remote, head, origin, journal, github, repair: new ManifestRepairService(github, ignore, journal), saved: () => saved };
}
describe('Read-only remote provenance audit', () => {
  it('proves generation 1 was valid when published and identifies a later external Tree edit', async () => {
    const f = fixture(); const result = await auditRemoteManifest(f.github.reader, f.head, ignore);
    expect(result).toMatchObject({ head: f.head, originCommit: f.origin, historyValid: true,
      diagnostics: [expect.objectContaining({ kind: 'BLOB_SHA_MISMATCH', path: 'A.md' })] });
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('rejects generation jumps and malformed commit/parent linkage distinctly', async () => {
    const f = fixture(); f.remote.external({ 'A.md': 'external edit', [MANIFEST_PATH]: JSON.stringify({ ...f.old, generation: 4 }) });
    expect((await auditRemoteManifest(f.github.reader, f.remote.head, ignore)).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'HISTORY_LINEAGE_MISMATCH' })]));
    const transport = f.remote.transport;
    f.remote.transport = async req => req.url.endsWith(`/commits/${f.remote.head}`)
      ? { status: 200, json: { sha: f.remote.head, tree: { sha: f.remote.commits.get(f.remote.head)!.tree }, parents: [{ sha: 'broken' }] } } : transport(req);
    await expect(auditRemoteManifest(f.github.reader, f.remote.head, ignore)).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ kind: 'COMMIT_PARENT_MISMATCH' })] });
  });
  it.each(['.local-mirror-sync/secret.json', 'ignored.log'])('identifies an excluded Manifest path: %s', async path => {
    const f = fixture();
    const scoped = new (ignore.constructor as typeof import('../src/vault/IgnoreService').IgnoreService)({ includeObsidian: false, configDir: '.obsidian', gitignore: '', patterns: '*.log' });
    f.remote.external({ 'A.md': 'original', [path]: 'hidden', [MANIFEST_PATH]: JSON.stringify(manifestOf(version('a', path))) });
    expect((await auditRemoteManifest(f.github.reader, f.remote.head, scoped)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: path.startsWith('.local') ? 'PROTECTED_PATH' : 'IGNORED_PATH', path }),
    ]));
  });
});
describe('Explicit manifest-only repair with retained backup and journal', () => {
  it('registers an explicitly reviewed remote addition without merging an identical existing identity; Windows and new-device Bootstrap converge', async () => {
    const f = fixture();
    f.remote.external({ 'A.md': 'original', 'copy/A.md': 'original', [MANIFEST_PATH]: JSON.stringify(f.old), '.obsidian/config.json': 'protected' });
    const head = f.remote.head; const before = { ...f.remote.contents() };
    const additions = [{ path: 'copy/A.md', blobSha: before['copy/A.md']!, fileId: 'reviewed-copy-id' }];
    const result = await f.repair.repair(head, additions);
    const manifest = JSON.parse(f.remote.text(MANIFEST_PATH));
    expect(manifest.generation).toBe(2);
    expect(manifest.files['id-1']).toEqual(f.old.files['id-1']);
    expect(manifest.files['reviewed-copy-id']).toEqual({ ...additions[0], deleted: false, revision: 1 });
    expect(f.remote.contents()).toEqual({ ...before, [MANIFEST_PATH]: expect.any(String) });
    expect(f.remote.refs.get(result.backupRef)).toBe(head);
    expect((await f.repair.repair(head, additions)).head).toBe(result.head);
    expect(f.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
    for (const initial of [{ 'A.md': 'original' }, {}] as Record<string, string>[]) {
      const vault = new WritableVault(initial);
      const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: text => vault.writeInternal('state', text) }); await state.load();
      if (Object.keys(initial).length) await state.save({ ...state.current(), target, baseManifest: f.old, baseRemoteCommit: f.origin });
      const service = new SyncService(vault, f.remote.transport, '.obsidian', state);
      const preview = await service.preview(options, 'fixture');
      expect(preview.mode).toBe(Object.keys(initial).length ? 'SYNC' : 'BOOTSTRAP');
      expect(preview.canExecute).toBe(true); expect(preview.requiresDeleteConfirmation).toBe(false);
      await service.execute(preview, 'fixture');
      expect(state.current().baseManifest).toEqual(manifest);
      expect(vault.files.get('copy/A.md')).toEqual(bytes('original'));
      expect(vault.files.get('A.md')).toEqual(bytes('original'));
    }
  });
  it.each(['wrong-sha', 'missing-review', 'extra-review', 'existing-id'])('rejects unsafe registration %s before any write', async variant => {
    const f = fixture(); f.remote.external({ 'A.md': 'original', 'copy.md': 'copy', [MANIFEST_PATH]: JSON.stringify(f.old) });
    const additions = [{ path: 'copy.md', blobSha: f.remote.contents()['copy.md']!, fileId: 'new-id' }];
    if (variant === 'wrong-sha') additions[0]!.blobSha = 'a'.repeat(40);
    if (variant === 'missing-review') additions.length = 0;
    if (variant === 'extra-review') additions.push({ path: 'other.md', blobSha: 'a'.repeat(40), fileId: 'other-id' });
    if (variant === 'existing-id') additions[0]!.fileId = 'id-1';
    await expect(f.repair.repair(f.remote.head, additions)).rejects.toThrow();
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true); expect(f.saved()).toBeNull();
  });
  it('does not treat a missing tracked path plus an untracked path as an additive repair', async () => {
    const f = fixture(); f.remote.external({ 'renamed.md': 'original', [MANIFEST_PATH]: JSON.stringify(f.old) });
    await expect(f.repair.repair(f.remote.head, [{ path: 'renamed.md', blobSha: f.remote.contents()['renamed.md']!, fileId: 'new-id' }])).rejects.toThrow();
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('blocked repository preview never fabricates deletion impact from untracked paths and local-only files', async () => {
    const f = fixture();
    f.remote.external({ 'A.md': 'original', ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`remote-${i}.md`, 'remote'])), [MANIFEST_PATH]: JSON.stringify(f.old) });
    const vault = new WritableVault(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`local-${i}.md`, 'local'])));
    const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: text => vault.writeInternal('state', text) }); await state.load();
    const service = new SyncService(vault, f.remote.transport, '.obsidian', state);
    const preview = await service.preview(options, 'fixture');
    expect(preview).toMatchObject({ mode: 'BLOCKED', canExecute: false, deletions: 0, requiresDeleteConfirmation: false,
      plan: { status: 'REMOTE_MANIFEST_INVALID', executionAllowed: false, entries: [] } });
    await expect(service.execute(preview, 'fixture', () => {}, undefined, 'DELETE 37')).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true); expect(vault.mutations).toEqual([]);
  });
  it('keeps every user/protected blob and Stable ID, increments only the changed revision and generation, then enters normal Attach Preview', async () => {
    const f = fixture(); const before = { ...f.remote.contents() };
    const result = await f.repair.repair(f.head);
    const manifest = JSON.parse(f.remote.text(MANIFEST_PATH));
    expect(manifest.generation).toBe(2); expect(manifest.files['id-1']).toMatchObject({ fileId: 'id-1', path: 'A.md', revision: 2, blobSha: before['A.md'] });
    expect(f.remote.contents()).toEqual({ ...before, [MANIFEST_PATH]: expect.any(String) });
    expect(f.remote.refs.get(result.backupRef)).toBe(f.head);
    expect(f.remote.commits.get(result.head)!.parents).toEqual([f.head]);
    expect(f.remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    expect(f.remote.calls.find(c => c.method === 'POST' && c.resource === 'trees')!.body!.tree).toEqual([expect.objectContaining({ path: MANIFEST_PATH })]);
    expect(JSON.parse(f.saved()!).phase).toBe('verified');
    const vault = new WritableVault({ 'A.md': 'local competing edit', 'new.md': 'local new' });
    const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: text => vault.writeInternal('state', text) }); await state.load();
    const service = new SyncService(vault, f.remote.transport, '.obsidian', state);
    const preview = await service.preview(options, 'fixture');
    expect(preview.mode).toBe('ATTACH'); expect(preview.plan.counts.PUSH_ADD).toBe(1); expect(preview.plan.hasConflicts).toBe(true);
    expect(state.current().baseManifest).toBeUndefined(); expect(vault.mutations).toEqual([]);
  });
  it('stale reviewed HEAD performs zero writes', async () => {
    const f = fixture(); await expect(f.repair.repair(f.origin)).rejects.toMatchObject({ code: 'REMOTE_HEAD_CHANGED' });
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true); expect(f.saved()).toBeNull();
  });
  it('refuses missing/untracked paths rather than guessing identity or deleting notes', async () => {
    const f = fixture(); f.remote.external({ 'renamed.md': 'external edit', [MANIFEST_PATH]: JSON.stringify(f.old) });
    await expect(f.repair.repair(f.remote.head)).rejects.toMatchObject({ code: 'MANIFEST_REPAIR_UNSAFE' });
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('recovers a lost PATCH response by proving the candidate, with no second commit', async () => {
    const f = fixture(); f.remote.losePatchResponse = true;
    const result = await f.repair.repair(f.head);
    expect(result.head).toBe(f.remote.head); expect(f.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
    expect(f.remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
  it('blocks branch advancement, retains the journal/backup, and never forces publication', async () => {
    const f = fixture(); f.remote.beforePatch = () => f.remote.external({ 'concurrent.md': 'new', [MANIFEST_PATH]: JSON.stringify(f.old) });
    await expect(f.repair.repair(f.head)).rejects.toThrow();
    expect(f.remote.text('concurrent.md')).toBe('new'); expect(f.saved()).not.toBeNull(); expect([...f.remote.refs.values()]).toContain(f.head);
    expect(f.remote.calls.filter(c => c.method === 'PATCH').every(c => c.body!.force === false)).toBe(true);
  });
  it('does not publish a corrupt candidate Tree', async () => {
    const f = fixture(); const transport = f.remote.transport;
    f.remote.transport = async req => {
      const result = await transport(req);
      if (req.method === 'POST' && req.url.endsWith('/trees')) f.remote.trees.get((result.json as { sha: string }).sha)!['A.md'] = f.remote.blob(bytes('wrong'));
      return result;
    };
    await expect(f.repair.repair(f.head)).rejects.toThrow();
    expect(f.remote.head).toBe(f.head); expect(f.remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });
  it('restarts from a durable candidate after failed publication, and verified retries are idempotent', async () => {
    const f = fixture(); const transport = f.remote.transport;
    f.remote.transport = async req => req.method === 'PATCH' ? { status: 503, json: {} } : transport(req);
    await expect(f.repair.repair(f.head)).rejects.toThrow();
    const candidate = JSON.parse(f.saved()!).candidate; expect(candidate).toBeTruthy(); expect(f.remote.head).toBe(f.head);
    f.remote.transport = transport;
    const service = new ManifestRepairService(f.github, ignore, f.journal);
    expect((await service.repair(f.head)).head).toBe(candidate);
    expect((await service.repair(f.head)).head).toBe(candidate);
    expect(f.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(1);
  });
  it('fails closed on damaged journal/read-back and retains existing evidence', async () => {
    const f = fixture();
    await f.journal.write('damaged'); await expect(f.repair.repair(f.head)).rejects.toMatchObject({ code: 'REPAIR_JOURNAL_INVALID' });
    expect(f.saved()).toBe('damaged'); expect(f.remote.calls).toEqual([]);
    const service = new ManifestRepairService(f.github, ignore, { read: async () => null, write: async () => {} });
    await expect(service.repair(f.head)).rejects.toMatchObject({ code: 'REPAIR_JOURNAL_UNVERIFIED' });
    expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('invalid Manifest cannot execute even after callers forge the UI flags', async () => {
    const f = fixture(); const vault = new WritableVault({ 'A.md': 'local note' });
    const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: text => vault.writeInternal('state', text) }); await state.load();
    const service = new SyncService(vault, f.remote.transport, '.obsidian', state); const preview = await service.preview(options, 'fixture');
    expect(preview).toMatchObject({ mode: 'BLOCKED', canExecute: false, plan: { entries: [], status: 'REMOTE_MANIFEST_INVALID' } });
    preview.canExecute = true; preview.mode = 'SYNC'; preview.plan.status = 'READY';
    await expect(service.execute(preview, 'fixture')).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(state.current().baseManifest).toBeUndefined(); expect(vault.mutations).toEqual([]); expect(f.remote.calls.every(c => c.method === 'GET')).toBe(true);
  });
});

describe('Normal publication verifies the complete candidate before updating the ref', () => {
  it('a dropped user blob fails before PATCH and before BASE/local apply', async () => {
    const remote = new GitFixture(); const vault = new WritableVault({ 'A.md': 'note' });
    const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: text => vault.writeInternal('state', text) }); await state.load();
    const transport = remote.transport;
    remote.transport = async req => {
      const result = await transport(req);
      if (req.method === 'POST' && req.url.endsWith('/trees')) delete remote.trees.get((result.json as { sha: string }).sha)!['A.md'];
      return result;
    };
    const service = new SyncService(vault, remote.transport, '.obsidian', state); const preview = await service.preview(options, 'fixture');
    await expect(service.execute(preview, 'fixture')).rejects.toThrow();
    expect(remote.calls.filter(c => c.method === 'PATCH')).toHaveLength(0); expect(state.current().baseManifest).toBeUndefined(); expect(vault.mutations).toEqual([]);
  });
});
