import type { LocalFile, LocalSnapshot } from '../../vault/VaultScanner';
import type { RemoteEntry } from '../../github/types';
import type { IgnoreService } from '../../vault/IgnoreService';
import type { SyncManifest } from '../manifest/ManifestSchema';
import type { LocalFileState } from '../state/LocalSyncState';
import type { RenameEvent } from './FileIdentity';

export function renamedPath(path: string, event: RenameEvent): string {
  return path === event.oldPath ? event.path : path.startsWith(`${event.oldPath}/`) ? event.path + path.slice(event.oldPath.length) : path;
}
export function syncDomain(base: SyncManifest | null, manifest: SyncManifest | null, local: LocalSnapshot, remoteFiles: RemoteEntry[],
  localFiles: Record<string, LocalFileState>, events: RenameEvent[], ignore: IgnoreService) {
  const ignored = new Set(local.ignored.map(file => file.path));
  const eligible = (path: string) => !ignored.has(path) && !ignore.reason(path);
  const excludedIds = new Set<string>(); const excludedPaths = new Set<string>();
  const ids = new Set([...Object.keys(base?.files ?? {}), ...Object.keys(manifest?.files ?? {}), ...Object.keys(localFiles)]);
  for (const id of ids) {
    const paths = [base?.files[id]?.path, manifest?.files[id]?.path, localFiles[id]?.path].filter((path): path is string => path !== undefined);
    let current = localFiles[id]?.path ?? base?.files[id]?.path;
    for (const event of events) if (current) { current = renamedPath(current, event); paths.push(current); }
    if (paths.some(path => !eligible(path))) { excludedIds.add(id); paths.forEach(path => excludedPaths.add(path)); }
  }
  const inDomain = (path: string) => eligible(path) && !excludedPaths.has(path);
  const filterManifest = (value: SyncManifest | null): SyncManifest | null => value === null ? null : {
    ...value, files: Object.fromEntries(Object.entries(value.files).filter(([id]) => !excludedIds.has(id))),
  };
  return { base: filterManifest(base), manifest: filterManifest(manifest), eligible: inDomain,
    local: local.files.filter((file: LocalFile) => inDomain(file.path)), remote: remoteFiles.filter(file => inDomain(file.path)),
    localFiles: Object.fromEntries(Object.entries(localFiles).filter(([id]) => !excludedIds.has(id))),
    events: events.filter(event => inDomain(event.oldPath) && inDomain(event.path)),
  };
}
