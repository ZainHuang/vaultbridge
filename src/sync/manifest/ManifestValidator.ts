import { ManifestValidationError, type ManifestIssue } from './ManifestDiagnostics';
import { assertPath, portablePathIssue } from '../../vault/paths';
import type { ManifestFileEntry, SyncManifest } from './ManifestSchema';

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isCounter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
export function validFileMetadata(value: unknown, allowMissingHash = false): boolean {
  if (!isRecord(value) || !isIdentity(value.fileId) || typeof value.path !== 'string' || typeof value.deleted !== 'boolean') return false;
  try { assertPath(value.path); } catch { return false; }
  if (portablePathIssue(value.path)) return false;
  return value.blobSha === undefined ? allowMissingHash || value.deleted : isSha(value.blobSha);
}
export function invalidManifest(diagnostics: ManifestIssue[] = [{ kind: 'SCHEMA_VALIDATION_FAILURE' }]): ManifestValidationError {
  return new ManifestValidationError(diagnostics);
}

/** JSON.parse discards duplicate keys; reject them before accepting an identity map. */
function rejectDuplicateKeys(text: string): void {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const keys = stack[stack.length - 1];
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) throw invalidManifest([{ kind: 'DUPLICATE_FILE_ID', fileId: key, detail: 'Duplicate JSON object key' }]);
      keys?.add(key);
    }
  }
}

export function parseManifest(input: unknown): SyncManifest {
  let value: unknown = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { throw invalidManifest([{ kind: 'SCHEMA_VALIDATION_FAILURE', detail: 'Invalid JSON' }]); }
    rejectDuplicateKeys(input);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isCounter(value.generation) || !isRecord(value.files)) throw invalidManifest();
  const ids = new Set<string>();
  const livePaths = new Set<string>();
  const files: Record<string, ManifestFileEntry> = Object.create(null) as Record<string, ManifestFileEntry>;
  for (const [key, data] of Object.entries(value.files)) {
    if (isRecord(data) && (typeof data.deleted !== 'boolean' || data.deleted === false && !isSha(data.blobSha))) {
      throw invalidManifest([{ kind: 'INVALID_ENTRY_STATE', fileId: key, path: typeof data.path === 'string' ? data.path : undefined, detail: 'Live entries require a blob SHA; deleted must be boolean' }]);
    }
    if (!isRecord(data) || !validFileMetadata(data) || !isCounter(data.revision)) throw invalidManifest([{ kind: 'SCHEMA_VALIDATION_FAILURE', fileId: key }]);
    const entry = data as unknown as ManifestFileEntry;
    if (key !== entry.fileId || ids.has(entry.fileId)) throw invalidManifest([{ kind: 'DUPLICATE_FILE_ID', fileId: entry.fileId, path: entry.path, detail: `Identity key ${key} does not uniquely match fileId` }]);
    if (!entry.deleted && livePaths.has(entry.path)) throw invalidManifest([{ kind: 'DUPLICATE_LIVE_PATH', fileId: entry.fileId, path: entry.path }]);
    if (entry.lastChangedBy !== undefined && !isIdentity(entry.lastChangedBy)) throw invalidManifest();
    if (entry.lastChangedAt !== undefined && (typeof entry.lastChangedAt !== 'string' || !Number.isFinite(Date.parse(entry.lastChangedAt)))) throw invalidManifest();
    ids.add(entry.fileId);
    if (!entry.deleted) livePaths.add(entry.path);
    files[key] = { ...entry };
  }
  return { schemaVersion: 1, generation: value.generation, files };
}
