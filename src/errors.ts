export class PreviewError extends Error {
  constructor(public readonly stage: string, public readonly code: string, message: string) {
    super(message);
    this.name = 'PreviewError';
  }
}

// Never surface transport errors: they may contain Authorization headers or bodies.
export function safeError(error: unknown): string {
  return error instanceof PreviewError
    ? `${error.stage} · ${error.code}: ${error.message}`
    : 'PREVIEW · FAILED: Preview failed. Check settings and retry.';
}

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PreviewError('PREVIEW', 'CANCELLED', 'Preview cancelled.');
}
