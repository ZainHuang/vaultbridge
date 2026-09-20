import { describe, expect, it } from 'vitest';
import { StatefulPreviewService } from '../src/sync/StatefulPreviewService';
import { previewGroups } from '../src/ui/PreviewModel';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { manifestOf, version } from './stateful-helpers';
import { MemoryVault, bytes, referenceSha, target, remoteTransport, treeEntries } from './helpers';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import type { LocalSyncState } from '../src/sync/state/LocalSyncState';
import type { GetRequest, GetTransport } from '../src/github/types';

const options = { ...DEFAULT_SETTINGS, ...target };
const state = (): LocalSyncState => ({ schemaVersion: 1, deviceId: '12345678-1234-4234-8234-123456789abc' });
function transport(manifest: unknown, files: Record<string, string>, calls: GetRequest[] = [], onBlob = () => {}) {
  const text = JSON.stringify(manifest), sha = referenceSha(bytes(text));
  const tree = remoteTransport(treeEntries(Object.fromEntries(Object.entries({ ...files, [MANIFEST_PATH]: text }).map(([p, c]) => [p, bytes(c)]))), calls);
  const result: GetTransport = async request => {
    if (!request.url.includes('/blobs/')) return tree(request);
    calls.push(request); onBlob();
    return { status: 200, json: { sha, size: bytes(text).length, encoding: 'base64', content: Buffer.from(text).toString('base64') } };
  };
  return result;
}
describe('Stateful Preview integration', () => {
  const entry = { ...version(), blobSha: referenceSha(bytes('old')) };
  const manifest = manifestOf(entry);
  it('a production service preview bootstraps a new empty device and never promotes BASE', async () => {
    const calls: GetRequest[] = []; const current = state();
    const service = new StatefulPreviewService(new MemoryVault(), transport(manifest, { 'A.md': 'old' }, calls), '.obsidian', () => current);
    const result = await service.preview(options, '');
    expect(result.plan).toMatchObject({ status: 'BOOTSTRAP_FROM_REMOTE', remoteCount: 1, executionAllowed: false });
    expect(result.state).toEqual(current); expect(current.baseManifest).toBeUndefined();
    expect(calls).toHaveLength(4); expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('uses persisted BASE, returns directional updates, and keeps preview/state deterministic', async () => {
    const current = { ...state(), target, baseManifest: manifest };
    const before = JSON.stringify(current);
    const service = new StatefulPreviewService(new MemoryVault({ 'A.md': 'new' }), transport(manifest, { 'A.md': 'old' }), '.obsidian', () => current);
    const first = await service.preview(options, '');
    expect(first.plan.counts.PUSH_UPDATE).toBe(1);
    expect(await service.preview(options, '')).toEqual(first);
    expect(JSON.stringify(current)).toBe(before);
    expect(previewGroups(first.plan)).toEqual({ Push: 1, Pull: 0, Conflict: 0, Bootstrap: 0, Unchanged: 0 });
  });
  it('blocks local changes during manifest GET, including same-size bytes', async () => {
    const vault = new MemoryVault({ 'A.md': 'old' });
    const service = new StatefulPreviewService(vault, transport(manifest, { 'A.md': 'old' }, [], () => vault.files.set('A.md', bytes('NEW'))), '.obsidian', state);
    await expect(service.preview(options, '')).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
  });
  it('shows invalid manifest as a blocked preview without partial entries', async () => {
    const service = new StatefulPreviewService(new MemoryVault(), transport({ schemaVersion: 9 }, {}), '.obsidian', state);
    expect((await service.preview(options, '')).plan).toMatchObject({ status: 'REMOTE_MANIFEST_INVALID', entries: [], reason: expect.stringContaining('SCHEMA_VALIDATION_FAILURE') });
    const duplicate = `{"schemaVersion":1,"generation":1,"files":{"id-1":${JSON.stringify(entry)},"id-1":${JSON.stringify(entry)}}}`;
    const sha = referenceSha(bytes(duplicate));
    const tree = remoteTransport(treeEntries({ [MANIFEST_PATH]: bytes(duplicate) }));
    const duplicateService = new StatefulPreviewService(new MemoryVault(), request => request.url.includes('/blobs/')
      ? Promise.resolve({ status: 200, json: { sha, size: bytes(duplicate).length, encoding: 'base64', content: Buffer.from(duplicate).toString('base64') } }) : tree(request), '.obsidian', state);
    expect((await duplicateService.preview(options, '')).plan.reason).toContain('DUPLICATE_FILE_ID');
  });
  it('never uses a base belonging to another target or an unbound target', async () => {
    for (const prior of [undefined, { ...target, repository: 'other' }]) {
      const service = new StatefulPreviewService(new MemoryVault(), transport(manifest, { 'A.md': 'old' }), '.obsidian', () => ({ ...state(), target: prior, baseManifest: manifest }));
      await expect(service.preview(options, '')).rejects.toMatchObject({ code: 'LOCAL_STATE_TARGET_MISMATCH' });
    }
  });
  it('keeps new nonempty, legacy, empty-remote and missing-manifest previews distinct', async () => {
    const cases = [
      { current: state(), files: { 'A.md': 'old' }, data: manifest, remoteFiles: { 'A.md': 'old' }, expected: 'BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY' },
      { current: state(), files: {}, data: null, remoteFiles: { 'A.md': 'old' }, expected: 'LEGACY_REMOTE_REQUIRES_ADOPTION' },
      { current: state(), files: {}, data: null, remoteFiles: {}, expected: 'INITIALIZE_REMOTE_FROM_LOCAL' },
      { current: { ...state(), target, baseManifest: manifest }, files: {}, data: null, remoteFiles: {}, expected: 'REMOTE_MANIFEST_MISSING' },
    ];
    for (const row of cases) {
      const network = row.data ? transport(row.data, row.remoteFiles) : remoteTransport(treeEntries(Object.fromEntries(Object.entries(row.remoteFiles).map(([p, c]) => [p, bytes(c)]))));
      const result = await new StatefulPreviewService(new MemoryVault(row.files as Record<string, string>), network, '.obsidian', () => row.current).preview(options, '');
      expect(result.plan.status).toBe(row.expected); expect(result.plan.entries).toEqual([]);
    }
  });
  it('ignores persisted legacy Primary declarations when there is no synchronized base', async () => {
    const current = { ...state(), initializationState: 'INITIALIZED_AS_PRIMARY' };
    const result = await new StatefulPreviewService(new MemoryVault(), transport(manifest, { 'A.md': 'old' }), '.obsidian', () => current).preview(options, '');
    expect(result.plan.status).toBe('BOOTSTRAP_FROM_REMOTE');
  });
});

describe('Runtime rename metadata', () => {
  it('persists chained folder/file rename events, without changing BASE or user bytes', async () => {
    let saved: string | null = null;
    const store = new LocalStateStore({ read: async () => saved, write: async value => { saved = value; } });
    const initial = await store.load();
    const entry = { ...version(), path: 'Notes/A.md' };
    await store.save({ ...initial, target, baseManifest: manifestOf(entry) });
    await Promise.all([store.recordRename('Notes', 'Archive'), store.recordRename('Archive/A.md', 'Archive/B.md')]);
    expect(store.current().localFiles?.['id-1']).toMatchObject({ fileId: 'id-1', path: 'Archive/B.md' });
    expect(store.current().baseManifest).toEqual(manifestOf(entry));
    expect((await new LocalStateStore({ read: async () => saved, write: async () => {} }).load()).localFiles).toEqual(store.current().localFiles);
  });
});
