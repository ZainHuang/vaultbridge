import { Modal, type App } from 'obsidian';
import { keepModalAboveKeyboard } from './MobileModalViewport';

/** The reviewed Preview stays open; exact authorization is collected only when
 * the user chooses to execute it. Closing this dialog never starts a sync. */
export class SyncConfirmationModal extends Modal {
  private releaseViewport?: () => void;
  constructor(app: App, private readonly phrase: string, private readonly message: string,
    private readonly adoption: boolean, private readonly confirmed: (phrase: string) => void,
    private readonly closed: () => void) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('lms-modal', 'lms-confirm-modal');
    this.setTitle(this.adoption ? 'Confirm legacy adoption' : 'Confirm deletion');
    this.contentEl.createEl('p', { text: this.message, cls: 'lms-warning' });
    const form = this.contentEl.createEl('form');
    const label = form.createEl('label', { text: `Type ${this.phrase} to continue`, cls: 'lms-search-label' });
    const input = label.createEl('input', { cls: 'lms-confirm-input', attr: {
      'aria-label': this.adoption ? 'Adoption confirmation' : 'Delete confirmation',
      autocomplete: 'off', spellcheck: 'false',
    } });
    const actions = form.createDiv({ cls: 'lms-footer' });
    const confirm = actions.createEl('button', { text: this.adoption ? 'Confirm & Adopt' : 'Confirm & Sync', cls: 'mod-cta', attr: { type: 'submit' } });
    confirm.disabled = true;
    input.oninput = () => { confirm.disabled = input.value !== this.phrase; };
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } }).onclick = () => this.close();
    form.onsubmit = event => {
      event.preventDefault();
      if (input.value !== this.phrase) return;
      this.close(); this.confirmed(this.phrase);
    };
    this.releaseViewport = keepModalAboveKeyboard(this);
    input.focus();
  }

  onClose(): void {
    this.releaseViewport?.();
    this.contentEl.empty();
    this.closed();
  }
}
