import { TFile, type Vault } from 'obsidian';
import { PreviewError } from '../errors';
import type { SyncVault } from '../sync/execution/SyncVault';
import { gitBlobSha } from './HashService';
import { obsidianVaultReader } from './ObsidianVaultReader';
import { assertPath } from './paths';

export function obsidianSyncVault(vault: Vault): SyncVault {
  const adapter = vault.adapter;
  const internal = (path: string) => { assertPath(path); if (!path.startsWith('.local-mirror-sync/transactions/')) throw new Error('Invalid internal path'); };
  const parents = async (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!await adapter.exists(parent)) { try { await adapter.mkdir(parent); } catch (error) { if (!(await adapter.stat(parent)) || (await adapter.stat(parent))?.type !== 'folder') throw error; } }
      if ((await adapter.stat(parent))?.type !== 'folder') throw new Error('Parent is not a directory');
    }
  };
  const hash = async (path: string) => {
    const stat = await adapter.stat(path); if (!stat) return null;
    if (stat.type !== 'file') throw new PreviewError('LOCAL_APPLY', 'PATH_OCCUPIED', 'A directory occupies the destination. Recovery data is retained.');
    return gitBlobSha(await adapter.readBinary(path));
  };
  return {
    ...obsidianVaultReader(vault),
    removeEmptyFolder: async (path, recoveryPath) => {
      assertPath(path); internal(recoveryPath);
      if (path.startsWith('.') || path.split('/').some(part => part.startsWith('.'))) return;
      if ((await adapter.stat(path))?.type !== 'folder') return;
      const entries = await adapter.list(path);
      if (entries.files.length || entries.folders.length) return;
      // Some desktop adapters implement rmdir(false) with fs.rm, which rejects
      // even empty directories. Move instead: no recursive deletion on any OS.
      const destination = `${recoveryPath}/${crypto.randomUUID()}`;
      await parents(destination);
      await adapter.rename(path, destination);
      const moved = await adapter.list(destination);
      if (moved.files.length || moved.folders.length) {
        // A writer added children between the listing and rename. Restore the
        // entire folder when possible; otherwise keep all bytes in recovery.
        if (!await adapter.exists(path)) await adapter.rename(destination, path);
        else throw new PreviewError('LOCAL_APPLY', 'FOLDER_CHANGED', 'An old folder changed during cleanup. Concurrent contents are preserved in transaction empty-folders recovery. Review them before resuming.');
      }
      if ((await adapter.stat(path))?.type === 'folder') {
        const current = await adapter.list(path);
        if (!current.files.length && !current.folders.length) throw new PreviewError('LOCAL_APPLY', 'FOLDER_CLEANUP_FAILED', 'An old empty folder could not be removed. Resume to retry before reporting success.');
      }
    },
    readInternal: async path => { internal(path); return await adapter.exists(path) ? adapter.read(path) : null; },
    writeInternal: async (path, contents) => { internal(path); await parents(path); await adapter.write(path, contents); },
    removeInternal: async path => {
      if (path !== '.local-mirror-sync/transactions/active.json') throw new Error('Only the pending transaction pointer may be removed');
      if (await adapter.exists(path)) await adapter.remove(path);
    },
    apply: async (path, data, expected, recoveryPath) => {
      assertPath(path); internal(recoveryPath);
      if (path.startsWith('.local-mirror-sync/')) throw new Error('Protected path');
      const current = await hash(path); const desired = data ? gitBlobSha(data) : null;
      if (current === desired) return;
      const changed = () => new PreviewError('LOCAL_APPLY', 'LOCAL_CHANGED', 'Local content changed during sync. Original and concurrent bytes are preserved in transaction backups/quarantine. Review them before resuming.');
      const recovered = await hash(recoveryPath);
      if (current !== expected && !(current === null && recovered === expected && expected !== null)) throw changed();
      const tracked = vault.getAbstractFileByPath(path);
      if (data && current !== null && tracked instanceof TFile && tracked.extension === 'md') {
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new PreviewError('LOCAL_APPLY', 'INVALID_UTF8', 'A Markdown file contains invalid UTF-8. No content was replaced.'); }
        // Obsidian process() serializes read/check/write and keeps the editor on the
        // same TFile. A concurrent editor save cannot be silently overwritten.
        await vault.process(tracked, text => {
          const actual = gitBlobSha(new TextEncoder().encode(text));
          if (actual !== expected && actual !== desired) throw changed();
          return content;
        });
        if (await hash(path) !== desired) throw changed();
        return;
      }
      if (current !== null) {
        if (recovered !== null) throw changed();
        await parents(recoveryPath);
        // Move first, never overwrite a live note. A concurrent edit moves with it;
        // verify the moved bytes before creating the incoming version.
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await vault.rename(file, recoveryPath);
        else await adapter.rename(path, recoveryPath);
        if (await hash(recoveryPath) !== expected) {
          // Restore the newly discovered bytes if the original path is still empty.
          if (!await adapter.exists(path)) await adapter.rename(recoveryPath, path);
          throw changed();
        }
      }
      if (data) {
        await parents(path);
        if (await adapter.exists(path)) throw changed();
        // Vault.createBinary rejects an occupied destination on both desktop/mobile.
        await vault.createBinary(path, data.slice().buffer as ArrayBuffer);
        if (await hash(path) !== desired) throw changed();
      }
    },
  };
}
