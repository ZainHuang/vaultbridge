import type { Vault } from 'obsidian';
import type { ProductStorage } from './ProductStore';

export function obsidianProductStorage(vault: Vault): ProductStorage {
  const adapter = vault.adapter;
  const resolve = (path: string) => {
    if (path === 'product-state.json') return `${vault.configDir}/plugins/local-mirror-sync/${path}`;
    if (/^\.sync-history\/(index|history-\d{8}-\d{6}(?:-[a-f0-9-]+)?)\.json$/.test(path)) return path;
    throw new Error('Invalid observability path');
  };
  return {
    read: async path => { const p = resolve(path); return await adapter.exists(p) ? adapter.read(p) : null; },
    write: async (path, contents) => {
      const p = resolve(path); const parent = p.slice(0, p.lastIndexOf('/'));
      if (!await adapter.exists(parent)) await adapter.mkdir(parent);
      await adapter.write(p, contents);
    },
  };
}
