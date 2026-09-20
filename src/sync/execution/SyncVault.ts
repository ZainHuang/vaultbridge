import type { VaultReader } from '../../vault/VaultScanner';
export interface SyncVault extends VaultReader {
  readInternal(path: string): Promise<string | null>;
  writeInternal(path: string, contents: string): Promise<void>;
  removeInternal(path: string): Promise<void>;
  /** Quarantine an empty directory and restore it if concurrent children arrive. */
  removeEmptyFolder(path: string, recoveryPath: string): Promise<void>;
  /** No overwrite: quarantine the existing bytes, verify them, then exclusively create. */
  apply(path: string, data: Uint8Array | null, expected: string | null, recoveryPath: string): Promise<void>;
}
