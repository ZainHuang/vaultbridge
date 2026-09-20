import ignore, { type Ignore } from 'ignore';
import { assertPath, portableKey } from './paths';

export interface IgnoreOptions {
  includeObsidian: boolean;
  configDir: string;
  gitignore: string;
  patterns: string;
}

export class IgnoreService {
  private readonly matcher: Ignore;
  private readonly configDirs: string[];

  constructor(private readonly options: IgnoreOptions) {
    assertPath(options.configDir);
    this.configDirs = [...new Set(['.obsidian', portableKey(options.configDir)])];
    // Git-compatible semantics, including negation, anchoring and parent directories.
    // Audio matching is case-insensitive on every device; user settings run last.
    this.matcher = ignore({ ignorecase: true }).add(options.gitignore).add(options.patterns);
  }

  protectedReason(path: string): string | undefined {
    const key = portableKey(path);
    const under = (base: string) => key === base || key.startsWith(`${base}/`);
    if (under('.git') || under('.trash') || under('.local-mirror-sync') || under('.sync-history')) return 'Protected internal directory';
    for (const dir of this.configDirs) {
      if (under(`${dir}/plugins/local-mirror-sync`)) return 'Plugin code, token and device state are always excluded';
      if (under(`${dir}/cache`) || key === `${dir}/workspace.json` || key === `${dir}/workspace-mobile.json`) {
        return 'Protected Obsidian cache/workspace';
      }
      if (!this.options.includeObsidian && under(dir)) return 'Include .obsidian is off';
    }
    return undefined;
  }

  reason(path: string, directory = false): string | undefined {
    assertPath(path);
    return this.protectedReason(path) ?? (this.matcher.ignores(directory ? `${path}/` : path)
      ? '.gitignore / Ignore Patterns' : undefined);
  }
}
