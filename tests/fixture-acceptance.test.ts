import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PreviewService } from '../src/sync/PreviewService';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import type { VaultReader } from '../src/vault/VaultScanner';
import { remoteTransport, target } from './helpers';

it('acceptance dataset: 20 adds / edits / deletions / renames + 10 attachments + 10 ignored + 20 legacy', async () => {
  const base = resolve('test-vault');
  const reader: VaultReader = {
    list: async path => {
      const children = await readdir(resolve(base, path), { withFileTypes: true });
      const name = (part: string) => path ? `${path}/${part}` : part;
      return { files: children.filter(child => child.isFile()).map(child => name(child.name)), folders: children.filter(child => child.isDirectory()).map(child => name(child.name)) };
    },
    stat: async path => { try { const s = await stat(resolve(base, path)); return { type: s.isFile() ? 'file' : 'folder', size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
    readBinary: async path => { const value = await readFile(resolve(base, path)); return value.buffer.slice(value.byteOffset, value.byteOffset + value.length) as ArrayBuffer; },
  };
  const remote = JSON.parse(await readFile('test-repository/tree.json', 'utf8'));
  const expected = JSON.parse(await readFile('test-repository/expected.json', 'utf8'));
  const result = await new PreviewService(reader, remoteTransport(remote.tree), '.obsidian').preview({ ...DEFAULT_SETTINGS, ...target }, '');
  const { plan } = result;
  expect(result.gate.status).toBe('BLOCK_FIRST_SYNC_MASS_DELETE');
  expect(result.executionAllowed).toBe(false);
  expect(plan.counts).toEqual(expected.counts);
  expect(plan.operationCounts).toEqual(expected.operationCounts);
  expect(plan.localCount).toBe(expected.eligibleLocal);
  expect(plan.remoteCount).toBe(expected.eligibleRemote);
  expect(plan.highRisk).toBe(true);
});
