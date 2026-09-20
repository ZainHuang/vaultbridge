import { Modal, type App } from 'obsidian';
import { safeError } from '../errors';
import { PRIMARY_CONFIRMATION, primaryDeclarationBlock } from '../state/StateStore';
import type { PreviewResult } from '../sync/PreviewResult';
import { keepModalAboveKeyboard } from './MobileModalViewport';

export const BOOTSTRAP_PLACEHOLDER = 'Remote bootstrap is preview only. No files are downloaded and no synchronized base is established until a future Restore completes and passes verification.';

export function openBootstrapPlaceholder(app: App): Modal {
  const modal = new Modal(app);
  modal.modalEl.addClass('lms-modal', 'lms-bootstrap-modal');
  modal.setTitle('Initialize from GitHub');
  modal.contentEl.createEl('p', { text: BOOTSTRAP_PLACEHOLDER, cls: 'lms-wrap' });
  modal.contentEl.createEl('p', { text: 'Run Preview to inspect this device and its remote manifest.', cls: 'lms-muted' });
  modal.contentEl.createEl('button', { text: 'Close' }).onclick = () => modal.close();
  modal.open();
  return modal;
}

export type DeclarePrimary = (preview: PreviewResult, phrase: string, signal: AbortSignal) => Promise<void>;

export class DeclarePrimaryModal extends Modal {
  private readonly controller = new AbortController();
  private busy = false;
  private releaseViewport?: () => void;
  constructor(app: App, private readonly preview: PreviewResult, private readonly declare: DeclarePrimary, private readonly completed: () => void) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('lms-modal', 'lms-declare-modal');
    this.setTitle('Declare this device as Local Primary');
    this.releaseViewport = keepModalAboveKeyboard(this);
    const el = this.contentEl;
    el.createEl('p', { text: `Local files: ${this.preview.plan.localCount}`, cls: 'lms-declare-count' });
    el.createEl('p', { text: `Remote files: ${this.preview.plan.remoteCount}`, cls: 'lms-declare-count' });
    el.createEl('p', { text: 'This action marks the current local Vault as authoritative. Future Local → GitHub Mirror operations may delete remote-only files.', cls: 'lms-warning' });
    el.createEl('p', { text: 'Only the local DeviceState will change. GitHub will not be modified.', cls: 'lms-muted' });
    const block = primaryDeclarationBlock(this.preview);
    if (block) el.createEl('p', { text: block, cls: 'lms-error', attr: { role: 'alert' } });
    const label = el.createEl('label', { text: `Type ${PRIMARY_CONFIRMATION}`, cls: 'lms-search-label' });
    const input = label.createEl('input', { type: 'text', cls: 'lms-confirm-input', attr: { 'aria-label': PRIMARY_CONFIRMATION, autocomplete: 'off', spellcheck: 'false' } });
    const status = el.createEl('p', { cls: 'lms-wrap', attr: { role: 'status', 'aria-live': 'polite' } });
    const actions = el.createDiv({ cls: 'lms-device-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl('button', { text: 'Confirm Local Primary', cls: 'mod-cta' });
    confirm.disabled = true;
    const update = () => { confirm.disabled = this.busy || !!block || input.value !== PRIMARY_CONFIRMATION; };
    input.oninput = update;
    confirm.onclick = async () => {
      if (this.busy || block || input.value !== PRIMARY_CONFIRMATION) return;
      this.busy = true; update(); input.disabled = true;
      status.setText('Rechecking local files and remote HEAD before saving device authority…');
      try {
        await this.declare(this.preview, input.value, this.controller.signal);
        if (this.controller.signal.aborted) return;
        this.close(); this.completed();
      } catch (error) {
        if (!this.controller.signal.aborted) status.setText(safeError(error));
      } finally { this.busy = false; input.disabled = false; update(); }
    };
  }

  onClose(): void { this.releaseViewport?.(); this.controller.abort(); this.contentEl.empty(); }
}
