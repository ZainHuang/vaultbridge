import { assertActive, PreviewError } from '../errors';
import type { GetTransport, RepositoryTarget } from './types';

export function validateTarget(target: RepositoryTarget): void {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(target.owner)
    || !/^[a-zA-Z0-9_.-]+$/.test(target.repository) || /^\.{1,2}$/.test(target.repository)
    || !target.branch || target.branch.startsWith('-') || target.branch.startsWith('/')
    || target.branch.endsWith('/') || target.branch.endsWith('.') || target.branch.includes('..')
    || target.branch.includes('@{') || target.branch === '@' || target.branch.includes('//')
    || /[\x00-\x20\x7f~^:?*[\\]/.test(target.branch)
    || target.branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
    throw new PreviewError('SETTINGS', 'INVALID_TARGET', 'Enter a valid GitHub owner, repository and branch name.');
  }
}

/** The only network capability in Phase 1 is GET to api.github.com. */
export class GitHubClient {
  private readonly base: string;
  constructor(target: RepositoryTarget, private readonly token: string, private readonly transport: GetTransport) {
    validateTarget(target);
    this.base = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/git/`;
  }

  async get(resource: string, stage: string, signal?: AbortSignal): Promise<unknown> {
    assertActive(signal);
    if (!/^(ref\/heads\/|commits\/|trees\/)/.test(resource) && !/^blobs\/[a-f0-9]{40}$/.test(resource)) {
      throw new PreviewError(stage, 'INVALID_RESOURCE', 'Unsupported read endpoint.');
    }
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Local-Mirror-Sync/0.1.5',
    };
    // Mutable refs must be revalidated on every read. Obsidian's HTTP cache can
    // retain GET /git/ref/... for 60s; PATCH /git/refs/... is a different URL and
    // does not invalidate that entry. Immutable objects keep their normal cache.
    if (resource.startsWith('ref/')) headers['Cache-Control'] = 'no-cache, no-store';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const response = await this.transport({ url: this.base + resource, method: 'GET', headers, throw: false });
      assertActive(signal);
      if (response.status !== 200) {
        const hints: Record<number, string> = {
          401: 'Token is invalid or expired.',
          403: 'Access denied or GitHub rate limit reached. Check permissions and retry later.',
          404: 'Repository or branch was not found, or the token cannot access it. Initialize the branch if this is an empty repository.',
          409: 'Repository has no readable commit. Initialize the target branch before Preview.',
          429: 'GitHub rate limit reached. Retry later.',
        };
        throw new PreviewError(stage, `HTTP_${response.status}`, hints[response.status] ?? 'GitHub request failed. Run Preview again.');
      }
      return response.json;
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      throw new PreviewError(stage, 'NETWORK_ERROR', 'GitHub could not be read. Check your connection and retry Preview.');
    }
  }
}
