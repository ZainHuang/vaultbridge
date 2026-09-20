import { describe, expect, it } from 'vitest';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { IgnoreService } from '../src/vault/IgnoreService';
import { VaultScanner } from '../src/vault/VaultScanner';
import { MemoryVault } from './helpers';

function storage(initial: string | null = null) {
  let text = initial;
  return { read: async () => text, write: async (value: string) => { text = value; } };
}
describe('Local Sync State', () => {
  it('creates a random identity once, persists and reloads it without inventing a base', async () => {
    const disk = storage();
    const first = await new LocalStateStore(disk).load();
    expect(first.deviceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.schemaVersion).toBe(1);
    expect(first.baseManifest).toBeUndefined();
    expect(await new LocalStateStore(disk).load()).toEqual(first);
    expect((await new LocalStateStore(storage()).load()).deviceId).not.toBe(first.deviceId);
  });
  it('round trips confirmed base and tombstones, with detached reads', async () => {
    const disk = storage(); const store = new LocalStateStore(disk);
    const initial = await store.load();
    const baseManifest = { schemaVersion: 1 as const, generation: 37, files: { old: { fileId: 'old', path: '旧.md', deleted: true, revision: 18 } } };
    await store.save({ ...initial, baseManifest, lastSeenGeneration: 37, baseRemoteCommit: 'a'.repeat(40), localFiles: {} });
    const loaded = await new LocalStateStore(disk).load();
    expect(loaded.baseManifest).toEqual(baseManifest);
    delete loaded.baseManifest!.files.old;
    expect(store.current().baseManifest).toEqual(baseManifest);
  });
  it.each(['{', '{}', '{"schemaVersion":9}', '{"schemaVersion":1,"deviceId":"bad"}'])('blocks corrupt state without overwriting it: %s', async text => {
    const disk = storage(text);
    await expect(new LocalStateStore(disk).load()).rejects.toMatchObject({ code: 'LOCAL_STATE_INVALID' });
    expect(await disk.read()).toBe(text);
  });
  it('invalidates current state after uncertain save/read-back', async () => {
    const disk = storage(); const store = new LocalStateStore(disk); const state = await store.load();
    disk.write = async () => {};
    await expect(store.save({ ...state, lastSeenGeneration: 1 })).rejects.toMatchObject({ code: 'LOCAL_STATE_SAVE_FAILED' });
    expect(() => store.current()).toThrow();
  });
  it('does not scan plugin state even with includeObsidian and negated rules', async () => {
    const reader = new MemoryVault({ '.obsidian/plugins/local-mirror-sync/sync-state.json': 'private', 'note.md': 'note' });
    const ignore = new IgnoreService({ configDir: '.obsidian', includeObsidian: true, gitignore: '!**', patterns: '!**' });
    expect((await new VaultScanner(reader).scan(ignore)).files.map(file => file.path)).toEqual(['note.md']);
    expect(reader.reads).not.toContain('.obsidian/plugins/local-mirror-sync/sync-state.json');
  });
});
