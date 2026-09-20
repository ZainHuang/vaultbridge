import type { RemoteEntry } from '../github/types';
import type { IgnoreService } from './IgnoreService';
import { portableKey, portablePathIssue } from './paths';

/** Shared by the retained legacy planner and the three-way planner. */
export function pathConflictChecker(managed: string[], remote: RemoteEntry[], ignore: IgnoreService) {
  const spellings = new Map<string, Set<string>>();
  const directoryKeys = new Set<string>();
  for (const path of managed) {
    const parts = path.split('/');
    parts.forEach((_, index) => {
      const prefix = parts.slice(0, index + 1).join('/');
      const key = portableKey(prefix);
      const variants = spellings.get(key) ?? new Set<string>();
      variants.add(prefix); spellings.set(key, variants);
      if (index < parts.length - 1) directoryKeys.add(key);
    });
  }
  for (const entry of remote) if (entry.type === 'tree' && !ignore.reason(entry.path, true)) directoryKeys.add(portableKey(entry.path));
  const collisionKeys = new Set([...spellings].filter(([, variants]) => variants.size > 1).map(([key]) => key));
  const fileDirectoryKeys = new Set(managed.map(portableKey).filter(key => directoryKeys.has(key)));
  return (path: string, remote?: RemoteEntry): string | undefined => {
    const prefixes = path.split('/').map((_, index, parts) => portableKey(parts.slice(0, index + 1).join('/')));
    return portablePathIssue(path)
      ?? (prefixes.some(key => collisionKeys.has(key)) ? 'Case or Unicode-normalization path collision.' : undefined)
      ?? (prefixes.some(key => fileDirectoryKeys.has(key)) ? 'File/directory path collision requires review.' : undefined)
      ?? (remote && (remote.type !== 'blob' || remote.mode === '120000') ? 'Remote symlink or submodule is not a regular Vault file.' : undefined);
  };
}
