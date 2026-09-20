import { PreviewError } from '../../errors';

export type ManifestIssueKind = 'LIVE_PATH_MISSING' | 'UNTRACKED_ELIGIBLE_PATH' | 'BLOB_SHA_MISMATCH'
  | 'DUPLICATE_FILE_ID' | 'DUPLICATE_LIVE_PATH' | 'INVALID_ENTRY_STATE' | 'HISTORY_LINEAGE_MISMATCH'
  | 'COMMIT_PARENT_MISMATCH' | 'PROTECTED_PATH' | 'IGNORED_PATH' | 'SCHEMA_VALIDATION_FAILURE'
  | 'BLOB_INTEGRITY_FAILURE' | 'UNSUPPORTED_TREE_ENTRY';
export interface ManifestIssue {
  kind: ManifestIssueKind;
  path?: string;
  fileId?: string;
  expectedSha?: string | null;
  actualSha?: string | null;
  expected?: string | number | null;
  actual?: string | number | null;
  detail?: string;
}
export class ManifestValidationError extends PreviewError {
  constructor(public readonly diagnostics: ManifestIssue[]) {
    super('REMOTE_MANIFEST', 'REMOTE_MANIFEST_INVALID', `REMOTE_MANIFEST_INVALID: No file decisions were generated.\n${diagnostics.map(issue =>
      `${issue.kind}${issue.path ? ` · ${issue.path}` : ''}${issue.fileId ? ` · fileId ${issue.fileId}` : ''}`
      + (issue.expectedSha !== undefined ? ` · expected SHA ${issue.expectedSha ?? '(absent)'}; actual SHA ${issue.actualSha ?? '(absent)'}` : '')
      + (issue.expected !== undefined ? ` · expected ${issue.expected}; actual ${issue.actual}` : '')
      + (issue.detail ? ` · ${issue.detail}` : '')).join('\n')}`);
  }
}
export function manifestErrorReason(error: unknown): string {
  return error instanceof ManifestValidationError ? error.message : 'REMOTE_MANIFEST_INVALID: Validation failed. No file decisions were generated.';
}
