import assert from 'node:assert/strict';

export async function verifyMobileKeyboard({ page, remote, report, preview, close, state, getUI, screenshot }) {
  remote.external({ 'note.md': 'Remote version' });
  const before = await state();
  await preview();
  const ui = getUI();
  await ui.setViewportSize({ width: 390, height: 844 });
  await ui.evaluate(() => {
    document.body.classList.add('is-mobile', 'is-phone');
    window.__keyboardViewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, scale: 1 });
    window.__originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.__keyboardViewport });
  });
  // Reopen so production listeners bind to the simulated visual viewport.
  await close(); await preview();
  await ui.setViewportSize({ width: 390, height: 844 });
  await ui.getByRole('button', { name: 'Use Local', exact: true }).click();
  const input = ui.getByRole('textbox', { name: 'Adoption confirmation' });
  const execute = ui.getByRole('button', { name: 'Adopt & Verify', exact: true });
  assert(await execute.isDisabled());
  await input.evaluate(el => el.focus());
  const setKeyboard = async (height, offsetTop = 0, nativeHeight = 0, viewportEvent = true) => {
    await ui.evaluate(({ height, offsetTop, nativeHeight, viewportEvent }) => {
      const vv = window.__keyboardViewport;
      vv.height = height; vv.offsetTop = offsetTop;
      document.body.style.setProperty('--keyboard-height', `${nativeHeight}px`);
      if (viewportEvent) { vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')); }
    }, { height, offsetTop, nativeHeight, viewportEvent });
    await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const visible = async (bottom, top = 0) => {
    const bounds = await ui.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; };
      return { input: box('.lms-confirm-input'), footer: box('.lms-footer'), modal: box('.lms-modal'), overflow: [...document.querySelectorAll('.lms-modal, .modal-content')].some(el => el.scrollWidth > el.clientWidth + 1) };
    });
    report.keyboardBounds ??= []; report.keyboardBounds.push({ top, bottom, ...bounds });
    assert(bounds.input.top >= top && bounds.input.bottom <= bottom, `Confirmation obscured: ${JSON.stringify(bounds)}`);
    assert(bounds.footer.top >= top && bounds.footer.bottom <= bottom, `Actions obscured: ${JSON.stringify(bounds)}`);
    assert(bounds.modal.top >= top && bounds.modal.bottom <= bottom, `Modal exceeds visible viewport: ${JSON.stringify(bounds)}`);
    assert(!bounds.overflow);
  };
  report.keyboardHostRules = await ui.evaluate(() => [...document.styleSheets].flatMap(sheet => {
    try { return [...sheet.cssRules].map(rule => rule.cssText).filter(text => /keyboard-height|keyboard-is-shown/.test(text)); } catch { return []; }
  }));
  await setKeyboard(514);
  await screenshot('keyboard-visual-viewport');
  await visible(514);
  await input.fill('use local'); assert(await execute.isDisabled());
  await input.fill('USE LOCAL'); assert.equal(await execute.isDisabled(), false);
  await visible(514);
  await setKeyboard(430, 40); await visible(470, 40);
  await screenshot('keyboard-panned-viewport');
  // Native Obsidian can report keyboard height while visualViewport stays full-height.
  await setKeyboard(844, 0, 330, false); await visible(514);
  await screenshot('keyboard-native-height');
  await setKeyboard(514, 0, 330); await visible(514);
  await setKeyboard(844); await visible(844);
  await screenshot('keyboard-dismissed');
  // Keyboard height can arrive without visualViewport events; respect the iPhone safe areas too.
  await ui.evaluate(() => {
    document.body.style.setProperty('--safe-area-inset-top', '47px');
    document.body.style.setProperty('--safe-area-inset-bottom', '34px');
  });
  await setKeyboard(844, 0, 330, false); await visible(480, 47);
  await screenshot('keyboard-native-safe-area');
  await close();
  await setKeyboard(514);
  assert.equal(await ui.locator('.lms-viewport-container').count(), 0);
  await ui.evaluate(() => {
    Object.defineProperty(window, 'visualViewport', window.__originalViewport);
    document.body.style.removeProperty('--keyboard-height');
    document.body.style.removeProperty('--safe-area-inset-top');
    document.body.style.removeProperty('--safe-area-inset-bottom');
    document.body.classList.remove('is-mobile', 'is-phone');
  });
  await ui.setViewportSize({ width: 1200, height: 900 });
  await preview();
  assert.equal(await ui.locator('.lms-viewport-container').count(), 0);
  await ui.getByRole('button', { name: 'Use Remote', exact: true }).click();
  await ui.getByRole('textbox', { name: 'Adoption confirmation' }).fill('USE REMOTE');
  assert.equal(await ui.locator('.lms-execute').isDisabled(), false);
  await screenshot('keyboard-desktop-regression');
  await close();
  assert.deepEqual(await state(), before);
  assert(remote.calls.every(call => call.method === 'GET'));
  report.checks.push('Mobile confirmation and actions remain visible with visual viewport shrink/pan, native keyboard height, both signals, keyboard dismissal and modal reopen; exact phrase gate and desktop preserved; GET-only and unchanged BASE');
}
