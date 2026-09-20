import type { Modal } from 'obsidian';

/** Keep text entry inside the keyboard-visible area, including iOS native keyboard reporting. */
export function keepModalAboveKeyboard(modal: Modal): () => void {
  const { containerEl, contentEl } = modal;
  const doc = containerEl.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  const viewport = win.visualViewport;
  let frame: number | undefined;

  const update = () => {
    frame = undefined;
    const mobile = doc.body.matches('.is-mobile, .emulate-mobile') || win.matchMedia('(max-width: 600px)').matches;
    containerEl.classList.toggle('lms-viewport-container', mobile);
    if (!mobile) return;
    const top = viewport?.offsetTop ?? 0;
    const keyboard = Math.max(0, parseFloat(win.getComputedStyle(containerEl).getPropertyValue('--keyboard-height')) || 0);
    // Native keyboard height and visualViewport may describe the same occlusion.
    // Take the smaller visible region instead of subtracting the keyboard twice.
    const height = Math.max(0, Math.min(viewport?.height ?? win.innerHeight, win.innerHeight - keyboard - top));
    containerEl.style.setProperty('--lms-viewport-top', `${top}px`);
    containerEl.style.setProperty('--lms-viewport-height', `${height}px`);

    const focused = doc.activeElement;
    if (!focused || !contentEl.contains(focused) || !focused.matches('input, textarea')) return;
    const input = focused.getBoundingClientRect();
    const content = contentEl.getBoundingClientRect();
    const actions = focused.matches('.lms-confirm-input')
      ? contentEl.querySelector('.lms-footer, .lms-device-actions:last-child')?.getBoundingClientRect() : undefined;
    const bottom = actions && actions.bottom - input.top <= content.height - 16 ? actions.bottom : input.bottom;
    if (bottom > content.bottom - 8) contentEl.scrollTop += bottom - content.bottom + 8;
    else if (input.top < content.top + 8) contentEl.scrollTop += input.top - content.top - 8;
  };
  const schedule = () => { if (frame === undefined) frame = win.requestAnimationFrame(update); };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  contentEl.addEventListener('focusin', schedule);
  // Obsidian's native keyboard integration updates an inherited CSS variable.
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  update();
  return () => {
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    contentEl.removeEventListener('focusin', schedule);
    observer.disconnect();
    containerEl.classList.remove('lms-viewport-container');
    containerEl.style.removeProperty('--lms-viewport-top');
    containerEl.style.removeProperty('--lms-viewport-height');
  };
}
