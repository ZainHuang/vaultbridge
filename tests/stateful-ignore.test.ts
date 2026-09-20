import { describe, expect, it } from 'vitest';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { IgnoreService } from '../src/vault/IgnoreService';
import { VaultScanner } from '../src/vault/VaultScanner';
import { localSnapshot, remoteSnapshot, MemoryVault } from './helpers';
import { manifestOf, version, ignore as noIgnore } from './stateful-helpers';
describe('Out-of-domain and protected data', () => {
  const ignore = new IgnoreService({ includeObsidian: true, configDir: '.obsidian', gitignore: '*.mp3\nprivate/**', patterns: '' });
  it('permanently excludes metadata even under !** and never reads internal bytes', async () => {
    const protectedIgnore = new IgnoreService({ includeObsidian: true, configDir: '.custom', gitignore: '!**', patterns: '!**' });
    const reader = new MemoryVault({ '.local-mirror-sync/manifest.json': '{}', '.obsidian/plugins/local-mirror-sync/sync-state.json': '{}', '.custom/plugins/local-mirror-sync/data.json': '{}', 'user.md': 'note' });
    expect((await new VaultScanner(reader).scan(protectedIgnore)).files.map(e => e.path)).toEqual(['user.md']);
    expect(reader.reads).toEqual(['user.md']);
  });
  it('ignored base deletions and remote additions produce no sync decisions', () => {
    const remote = remoteSnapshot({ 'sound.mp3': 'old', 'private/remote.md': 'secret' });
    const entries = remote.entries.map((e, i) => ({ ...version(), path: e.path, blobSha: e.sha, fileId: `id-${i}` }));
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(entries[0]!), local: localSnapshot({}), remote, remoteManifest: { ...manifestOf(...entries), generation: 2 } }, ignore);
    expect(plan).toMatchObject({ status: 'READY', entries: [], remoteCount: 0 });
  });
  it.each(['local rename to ignored', 'remote rename to ignored', 'local rename from ignored'])('excludes the whole identity for %s', scenario => {
    const original = scenario === 'local rename from ignored' ? 'private/A.md' : 'A.md';
    const moved = scenario === 'local rename from ignored' ? 'B.md' : 'private/A.md';
    const remote = remoteSnapshot({ [scenario === 'remote rename to ignored' ? moved : original]: 'old' });
    const entry = { ...version(), path: original, blobSha: remote.entries[0]!.sha };
    const localPath = scenario === 'remote rename to ignored' ? original : moved;
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(entry), local: localSnapshot({ [localPath]: 'old' }), remote,
      remoteManifest: { ...manifestOf({ ...entry, path: remote.entries[0]!.path, revision: 2 }), generation: 2 },
      localFiles: { 'id-1': { ...entry, path: localPath } } }, ignore);
    expect(plan.status).toBe('READY'); expect(plan.entries).toEqual([]);
  });
  it('an explicit rename across the ignore boundary stays out of the state machine', () => {
    const remote = remoteSnapshot({ 'A.md': 'old' }); const base = manifestOf({ ...version(), blobSha: remote.entries[0]!.sha });
    const plan = new ThreeWaySyncPlanner().create({ base, local: localSnapshot({ 'private/A.md': 'old' }), remote, remoteManifest: base,
      renameEvents: [{ oldPath: 'A.md', path: 'private/A.md' }] }, ignore);
    expect(plan.entries).toEqual([]);
  });
  it('a metadata-only remote is not mistaken for a legacy user repository', () => {
    const remote = remoteSnapshot({ '.local-mirror-sync/manifest.json': JSON.stringify(manifestOf()) });
    const plan = new ThreeWaySyncPlanner().create({ base: null, local: localSnapshot({}), remote, remoteManifest: manifestOf() }, noIgnore);
    expect(plan).toMatchObject({ status: 'BOOTSTRAP_FROM_REMOTE', remoteCount: 0 });
  });
  it.each([
    ['A.md', 'a.md'], ['Notes/a.md', 'notes/b.md'], ['folder', 'folder/note.md'], ['é.md', 'e\u0301.md'],
  ])('keeps existing portable path protection: %s vs %s', (left, right) => {
    const local = localSnapshot({ [left]: 'left', [right]: 'right' });
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(), local, remote: remoteSnapshot({}), remoteManifest: manifestOf() }, noIgnore);
    expect(plan.hasConflicts).toBe(true);
    expect(plan.entries.every(e => e.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
    expect(plan.counts.PUSH_ADD).toBe(0);
  });
});
