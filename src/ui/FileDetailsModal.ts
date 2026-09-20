import { Modal, type App } from 'obsidian';
import { keepModalAboveKeyboard } from './MobileModalViewport';

/** One scrolling detail surface with actions outside the scroll area. */
export class FileDetailsModal extends Modal {
  private releaseViewport?: () => void;
  constructor(app: App, private readonly render: (body: HTMLElement, actions: HTMLElement) => void,
    private readonly closed: () => void) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('lms-modal', 'lms-file-modal');
    this.setTitle('File details');
    const body = this.contentEl.createDiv({ cls: 'lms-file-body' });
    const actions = this.contentEl.createDiv({ cls: 'lms-device-actions lms-file-actions' });
    this.render(body, actions);
    actions.createEl('button', { text: 'Back to preview' }).onclick = () => this.close();
    this.releaseViewport = keepModalAboveKeyboard(this);
  }
  onClose(): void {
    this.releaseViewport?.();
    this.contentEl.empty();
    this.closed();
  }
}
