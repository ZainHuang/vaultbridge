import { assertActive, PreviewError } from '../errors';
import { PRIMARY_CONFIRMATION, primaryDeclarationBlock, type StateStore } from '../state/StateStore';
import type { Progress } from '../vault/VaultScanner';
import { declarationFingerprint, type PreviewResult } from './PreviewResult';

export type RunPreview = (progress: Progress, signal: AbortSignal) => Promise<PreviewResult>;

/** Coordinates only reads, audit metadata and the explicit local authority declaration. */
export class InitializationSession {
  private readonly issued = new WeakMap<PreviewResult, { context: string; fingerprint: string }>();
  constructor(private readonly store: StateStore, private readonly read: RunPreview,
    private readonly contextVersion: () => string = () => '') {}

  async preview(progress: Progress, signal: AbortSignal): Promise<PreviewResult> {
    const context = this.contextVersion();
    const result = await this.read(progress, signal);
    assertActive(signal);
    this.checkContext(context);
    const state = this.store.current();
    if (state.deviceId !== result.deviceState.deviceId || state.initializationState !== result.deviceState.initializationState) throw this.stale();
    await this.store.recordSuccessfulPreview(result);
    assertActive(signal);
    this.checkContext(context);
    const preview = { ...result, deviceState: this.store.current() };
    this.issued.set(preview, { context, fingerprint: declarationFingerprint(preview) });
    return preview;
  }

  async declarePrimary(expected: PreviewResult, phrase: string, signal: AbortSignal): Promise<void> {
    if (phrase !== PRIMARY_CONFIRMATION) throw new PreviewError('INITIALIZATION', 'CONFIRMATION_REQUIRED', `Type ${PRIMARY_CONFIRMATION} exactly.`);
    const block = primaryDeclarationBlock(expected);
    if (block) throw new PreviewError('INITIALIZATION', 'DECLARATION_BLOCKED', block);
    const context = this.contextVersion();
    const issued = this.issued.get(expected);
    if (!issued || issued.context !== context || issued.fingerprint !== declarationFingerprint(expected)) throw this.stale();
    const fresh = await this.preview(() => {}, signal);
    if (declarationFingerprint(expected) !== declarationFingerprint(fresh)) throw this.stale();
    await this.store.declareLocalPrimary(phrase, fresh, () => { assertActive(signal); this.checkContext(context); });
  }

  private checkContext(expected: string): void { if (this.contextVersion() !== expected) throw this.stale(); }
  private stale(): PreviewError {
    return new PreviewError('INITIALIZATION', 'STALE_PREVIEW', 'The Vault, remote HEAD, settings or device state changed. Refresh Preview before declaring Local Primary.');
  }
}
