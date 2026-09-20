import { PreviewError } from '../errors';

export function assertPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new PreviewError('SCAN', 'INVALID_PATH', 'An unsafe or malformed relative path was found.');
  }
}

export function portableKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

export function portablePathIssue(path: string): string | undefined {
  if (path.split('/').some(part => /[<>:"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    return 'Path is not portable to Windows.';
  }
  return undefined;
}

export const pathOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
