import { TFile, type Vault } from 'obsidian';
import type { VaultReader } from './VaultScanner';

export function obsidianVaultReader(vault: Vault): VaultReader {
  return {
    list: path => vault.adapter.list(path),
    stat: path => vault.adapter.stat(path),
    readBinary: path => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? vault.readBinary(file) : vault.adapter.readBinary(path);
    },
  };
}
