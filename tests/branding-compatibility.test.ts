import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../src/settings/TokenStore';
import { loadSettings } from '../src/settings/settings';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { SyncService } from '../src/sync/execution/SyncService';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import { IgnoreService } from '../src/vault/IgnoreService';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };

describe('VaultBridge branding and upgrade compatibility', () => {
  it('publishes VaultBridge using the original Obsidian installation identity', () => {
    expect(manifest.name).toBe('VaultBridge');
    expect(pkg.name).toBe('vaultbridge');
    expect(manifest.id).toBe('local-mirror-sync');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it('retains existing SecretStorage references and fallback settings without generating a new secret', () => {
    const settings = loadSettings({ ...options, secretName: 'local-mirror-sync-existing-fixture' });
    const secrets = { getSecret: vi.fn(() => 'synthetic-token'), setSecret: vi.fn() };
    const tokens = new TokenStore(secrets);
    expect(tokens.read(settings)).toBe('synthetic-token');
    expect(secrets.getSecret).toHaveBeenCalledWith(settings.secretName);
    expect(secrets.setSecret).not.toHaveBeenCalled();
    expect(tokens.withToken(settings, 'synthetic-replacement').secretName).toBe(settings.secretName);
    const fallback = loadSettings({ ...options, localToken: 'synthetic-local-token' });
    expect(new TokenStore().read(fallback)).toBe('synthetic-local-token');
  });

  it.each(['.obsidian', 'custom-config'])('keeps BASE, device identity, Manifest and pending Recovery after reload in %s', async configDir => {
    const vault = new WritableVault({ 'note.md': 'original fixture' });
    const remote = new GitFixture();
    const path = `${configDir}/plugins/${manifest.id}/sync-state.json`;
    const storage = { read: () => vault.readInternal(path), write: (s: string) => vault.writeInternal(path, s) };
    const state = new LocalStateStore(storage); await state.load();
    const service = new SyncService(vault, remote.transport, configDir, state);
    await service.execute(await service.preview(options, 'synthetic-token'), 'synthetic-token');
    const before = state.current();
    expect(before.baseManifest).toBeDefined();
    expect(MANIFEST_PATH).toBe('.local-mirror-sync/manifest.json');
    expect(JSON.parse(remote.text(MANIFEST_PATH))).toEqual(before.baseManifest);
    vault.files.set('note.md', bytes('next local edit'));
    const interrupted = new SyncService(vault, async request => request.method === 'PATCH'
      ? { status: 403, json: {} } : remote.transport(request), configDir, state);
    await expect(interrupted.execute(await interrupted.preview(options, 'synthetic-token'), 'synthetic-token')).rejects.toThrow();
    const transaction = await interrupted.transactions.active();
    expect(transaction).not.toBeNull();
    const saved = new Map(vault.internal);
    const reloaded = new LocalStateStore(storage); await reloaded.load();
    const upgraded = new SyncService(vault, remote.transport, configDir, reloaded);
    expect(reloaded.current()).toEqual(before);
    expect(await upgraded.transactions.active()).toEqual(transaction);
    await expect(upgraded.preview(options, 'synthetic-token')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(vault.internal).toEqual(saved);
    const ignore = new IgnoreService({ configDir, includeObsidian: true, gitignore: '!**', patterns: '!**' });
    for (const internal of [path, `${configDir}/plugins/${manifest.id}/data.json`, '.local-mirror-sync/transactions/active.json', '.sync-history/index.json']) {
      expect(ignore.reason(internal)).toBeTruthy();
    }
    await upgraded.resume(options, 'synthetic-token');
    expect(reloaded.current().deviceId).toBe(before.deviceId);
    expect(await upgraded.transactions.active()).toBeNull();
    expect(remote.text('note.md')).toBe('next local edit');
  });
});
