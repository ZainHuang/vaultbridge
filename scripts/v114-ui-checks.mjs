import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyV114({ page, remote, report, runDir, preview, close, state, surface, getUI }) {
  const before = await state();
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync']; const transport = plugin.sync.transport;
    plugin.sync.transport = async req => {
      const response = await transport(req);
      if (req.method === 'PATCH' && response.status === 200) {
        await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Concurrent user edit');
        await app.vault.create('新增用户文件.md', '# Added during sync');
        await app.vault.adapter.write('.obsidian/workspace-mobile.json', '{}');
      }
      return response;
    };
  });
  await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().locator('.lms-error').filter({ hasText: 'LOCAL_VERIFY_FAILED' }).waitFor();
  const error = getUI().locator('.lms-error').filter({ hasText: 'LOCAL_VERIFY_FAILED' });
  const text = await error.innerText();
  for (const expected of ['modified · note.md', 'added · 新增用户文件.md', 'expected blob SHA:', 'actual blob SHA:', 'ignored=false; protected/internal=false/false']) assert(text.includes(expected), expected);
  assert(!text.includes('workspace-mobile.json')); assert.deepEqual(await state(), before);
  assert.equal(await error.evaluate(el => getComputedStyle(el).whiteSpace), 'pre-line');
  const active = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active());
  assert.equal((await active()).phase, 'published');
  await getUI().screenshot({ path: join(runDir, 'v114-01-detailed-verify.png') }); report.screenshots.push('v114-01-detailed-verify.png');
  report.checks.push('Post-publication Verify displays exact paths, SHA pairs and domain flags; real edits retain BASE and Recovery; workspace excluded');
  await close();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  assert.deepEqual(await state(), before); assert(await active());
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await getUI().screenshot({ path: join(runDir, 'v114-02-recovery-mobile.png') }); report.screenshots.push('v114-02-recovery-mobile.png');
  const count = remote.calls.length;
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await surface('.lms-summary');
  const plan = await getUI().locator('.lms-modal').innerText();
  assert(plan.includes('PUSH_UPDATE') && plan.includes('PUSH_ADD'), plan);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# Concurrent user edit');
  assert.equal(await page.evaluate(() => app.vault.adapter.read('新增用户文件.md')), '# Added during sync');
  assert.equal(await active(), null); assert.equal((await state()).baseManifest.generation, 1);
  assert(remote.calls.slice(count).every(c => c.method === 'GET'));
  await getUI().screenshot({ path: join(runDir, 'v114-03-resumed.png') }); report.screenshots.push('v114-03-resumed.png');
  assert(await getUI().locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  report.checks.push('Recovery at 390px completes the published BASE, preserves later user edits, opens a fresh Three-Way Preview with PUSH_UPDATE/PUSH_ADD and makes GET-only requests');
}
