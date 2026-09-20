import assert from 'node:assert/strict';

export async function verifyMobileDetails({ page, remote, report, preview, sync, close, state, getUI, screenshot }) {
  await preview(); await sync(); await close();
  await page.evaluate(() => app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Local choice\n' + '本地内容与很长的文件信息。'.repeat(300)));
  const manifest = JSON.parse(remote.text('.local-mirror-sync/manifest.json'));
  const file = Object.values(manifest.files).find(file => file.path === 'note.md');
  file.blobSha = remote.blob(new TextEncoder().encode('# Remote choice\n' + '远端内容用于检查滚动和操作按钮。'.repeat(300))); file.revision++; manifest.generation++;
  const tree = remote.id(); remote.trees.set(tree, { ...remote.contents(), 'note.md': file.blobSha,
    '.local-mirror-sync/manifest.json': remote.blob(new TextEncoder().encode(JSON.stringify(manifest))) });
  const commit = remote.id(); remote.commits.set(commit, { tree, parents: [remote.head] }); remote.head = commit;
  const before = await state(); const requests = remote.calls.length;
  await preview(); const ui = getUI();
  await ui.setViewportSize({ width: 390, height: 844 });
  await ui.evaluate(() => document.body.classList.add('is-mobile', 'is-phone'));
  const row = () => ui.locator('.lms-entry').filter({ hasText: 'CONFLICT_CONTENT' });
  await row().locator('summary').click();
  const dialog = ui.locator('.lms-file-modal');
  assert.equal(await dialog.count(), 1, 'Mobile file details must open in an independent dialog instead of the small inline list');
  await screenshot('mobile-file-details');
  const fits = async () => {
    const bounds = await dialog.evaluate(el => {
      const box = el.getBoundingClientRect(); const actions = el.querySelector('.lms-file-actions').getBoundingClientRect();
      const scroll = el.querySelector('.lms-file-body');
      return { top: box.top, bottom: box.bottom, height: box.height, actionsTop: actions.top, actionsBottom: actions.bottom,
        viewport: innerHeight, width: innerWidth, overflow: el.scrollWidth > el.clientWidth + 1,
        bodyHeight: scroll.clientHeight, bodyScroll: scroll.scrollHeight };
    });
    report.detailsBounds ??= []; report.detailsBounds.push(bounds);
    assert(bounds.height > bounds.viewport * 0.8, JSON.stringify(bounds));
    assert(bounds.top >= 0 && bounds.bottom <= bounds.viewport, JSON.stringify(bounds));
    assert(bounds.actionsTop >= bounds.top && bounds.actionsBottom <= bounds.bottom, JSON.stringify(bounds));
    assert(!bounds.overflow); assert(bounds.bodyHeight > 80);
  };
  await fits();
  await dialog.getByRole('button', { name: 'Inspect both versions', exact: true }).click();
  await dialog.locator('.lms-compare').filter({ hasText: '# Remote choice' }).waitFor();
  assert((await dialog.locator('.lms-compare').innerText()).includes('# Local choice'));
  assert.equal(await ui.locator('.lms-file-modal').count(), 1);
  await fits(); await screenshot('mobile-file-versions');
  await dialog.locator('.lms-file-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await fits();
  await ui.setViewportSize({ width: 844, height: 390 }); await fits();
  await screenshot('mobile-file-landscape');
  await ui.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: 'Back to preview', exact: true }).click();
  assert.equal(await dialog.count(), 0); assert(await ui.locator('.lms-execute').isDisabled());
  await row().locator('summary').click();
  await dialog.getByRole('button', { name: 'Use REMOTE', exact: true }).click();
  assert.equal(await dialog.count(), 0); assert.equal(await ui.locator('.lms-execute').isDisabled(), false);
  assert.deepEqual(await state(), before);
  assert(remote.calls.slice(requests).every(call => call.method === 'GET'));
  assert((await page.evaluate(() => app.vault.adapter.read('note.md'))).includes('# Local choice'));
  report.checks.push('Mobile independent near-full-height details, pinned versions in the same dialog, visible actions, portrait/landscape and long content; explicit choice updates preview only, no file/BASE writes');
  await close(); await preview(); await ui.setViewportSize({ width: 390, height: 844 });
  await row().locator('summary').click(); await ui.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0); assert(await ui.locator('.lms-execute').isDisabled());
  // Filtering does not scope the bulk action, and selecting never executes it.
  for (const choice of ['LOCAL', 'REMOTE']) {
    await ui.locator('.lms-preview-modal').getByRole('searchbox').fill('no matching files');
    await ui.getByRole('button', { name: `Use ${choice} for all conflicts`, exact: true }).click();
    assert.equal(await ui.locator('.lms-execute').isDisabled(), false);
    assert((await ui.locator('.lms-operations').innerText()).includes(choice === 'LOCAL' ? 'Push 1' : 'Pull 1'));
    assert.deepEqual(await state(), before);
    await screenshot(`mobile-bulk-${choice.toLowerCase()}`);
    await close(); await preview(); await ui.setViewportSize({ width: 390, height: 844 });
  }
  // Even identity diagnostics expose both choices; protocol safety is tested by service regressions.
  await page.evaluate(() => {
    const modal = app.plugins.plugins['local-mirror-sync'].previewModal;
    const entry = modal.result.plan.entries.find(entry => entry.category === 'CONFLICT_CONTENT');
    entry.category = 'CONFLICT_IDENTITY_UNCERTAIN'; entry.reason = 'Identity requires your choice';
    modal.renderPlan(modal.result);
    window.__originalInspect = modal.actions.inspect;
    modal.actions.inspect = () => new Promise((resolve, reject) => { window.__inspectResolve = resolve; window.__inspectReject = reject; });
  });
  await ui.locator('.lms-entry').filter({ hasText: 'CONFLICT_IDENTITY_UNCERTAIN' }).locator('summary').click();
  assert(await dialog.getByRole('button', { name: 'Use LOCAL', exact: true }).isVisible());
  assert(await dialog.getByRole('button', { name: 'Use REMOTE', exact: true }).isVisible());
  assert((await dialog.locator('.lms-compare').innerText()).includes('Loading'));
  await screenshot('mobile-details-loading');
  await page.evaluate(() => window.__inspectReject(new Error('Fixture inspection failed')));
  await dialog.locator('.lms-compare').filter({ hasText: 'PREVIEW · FAILED' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Inspect both versions', exact: true }).isDisabled(), false);
  await screenshot('mobile-details-error');
  await page.evaluate(() => { const modal = app.plugins.plugins['local-mirror-sync'].previewModal; modal.actions.inspect = window.__originalInspect; });
  await dialog.getByRole('button', { name: 'Inspect both versions', exact: true }).click();
  await dialog.locator('.lms-compare').filter({ hasText: '# Remote choice' }).waitFor();
  await dialog.getByRole('button', { name: 'Back to preview', exact: true }).click();
  assert(remote.calls.slice(requests).every(call => call.method === 'GET'));
  report.checks.push('All-conflict choices work with a filter hiding the rows; all identity conflict choices stay visible; inspection loading/error/retry states remain usable and perform no writes');
  await close();
  await ui.evaluate(() => document.body.classList.remove('is-mobile', 'is-phone'));
  await ui.setViewportSize({ width: 1200, height: 900 }); await preview();
  await row().locator('summary').click();
  assert.equal(await dialog.count(), 0);
  assert(await row().getByRole('button', { name: 'Use LOCAL', exact: true }).isVisible());
  await screenshot('desktop-inline-details'); await close();
  report.checks.push('Back and Escape preserve unresolved conflicts; desktop inline details and explicit choices preserved');
}
