import assert from 'node:assert/strict';
import { join } from 'node:path';
export async function verifyManifestUI({ page, remote, report, runDir, preview, close, state, getUI }) {
  const path = '课程/第38期 Domain Object 与 Relationship——系统真正管理什么.md';
  const manifest = { schemaVersion: 1, generation: 1, files: { 'stable-id': { fileId: 'stable-id', path, blobSha: 'a'.repeat(40), deleted: false, revision: 1 } } };
  remote.external({ [path]: 'External Tree edit', '.local-mirror-sync/manifest.json': JSON.stringify(manifest) });
  const before = await state();
  await preview(); const ui = getUI();
  assert.equal(await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).isDisabled(), true);
  assert.equal(await ui.locator('.lms-summary, .lms-operations, .lms-confirm-input').count(), 0);
  assert.equal(await ui.locator('.lms-repair-guidance').count(), 1);
  const text = await ui.locator('.lms-blocking-banner').innerText();
  assert(text.includes('BLOB_SHA_MISMATCH')); assert(text.includes(path)); assert(text.includes('a'.repeat(40))); assert(text.includes(remote.contents()[path]));
  assert.equal(await ui.locator('.lms-empty, .lms-table-wrap').count(), 0);
  await ui.screenshot({ path: join(runDir, 'manifest-invalid-desktop.png') }); report.screenshots.push('manifest-invalid-desktop.png');
  await ui.setViewportSize({ width: 390, height: 844 });
  assert(await ui.locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 2));
  assert.equal(await ui.locator('.lms-modal').getByRole('searchbox').count(), 0);
  await ui.screenshot({ path: join(runDir, 'manifest-invalid-mobile.png') }); report.screenshots.push('manifest-invalid-mobile.png');
  // A stale caller cannot restore actions/counts merely by forging UI flags.
  for (const status of ['REMOTE_MANIFEST_INVALID', 'REMOTE_MANIFEST_MISSING', 'LOCAL_STATE_INVALID']) {
    await page.evaluate(status => {
      const modal = app.plugins.plugins['local-mirror-sync'].previewModal;
      const stale = { ...modal.result, mode: 'SYNC', canExecute: true, requiresDeleteConfirmation: true, deletions: 37,
        plan: { ...modal.result.plan, status, counts: { ...modal.result.plan.counts, PUSH_DELETE: 37 } } };
      modal.renderPlan(stale);
    }, status);
    assert(await ui.locator('.lms-execute').isDisabled());
    assert.equal(await ui.locator('.lms-summary, .lms-operations, .lms-confirm-input, .lms-table-wrap').count(), 0);
    assert(!(await ui.locator('.lms-modal').innerText()).includes('DELETE 37'));
  }
  assert.deepEqual(await state(), before); assert(remote.calls.every(c => c.method === 'GET'));
  report.checks.push('Invalid Manifest: exact path/SHA diagnostics, repair/review guidance, no fake counts/file plan/delete input, disabled Sync, 390px no overflow, unchanged BASE and GET-only network');
  await close();
  remote.external({ [path]: 'External Tree edit', '.local-mirror-sync/manifest.json': '{invalid json' });
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openPreview());
  await ui.locator('.lms-error[role="alert"]').waitFor();
  assert((await ui.locator('.lms-modal').innerText()).includes('REMOTE_MANIFEST_INVALID'));
  assert.equal(await ui.locator('.lms-repair-guidance').count(), 1);
  assert.equal(await ui.locator('.lms-confirm-input, .lms-summary, .lms-operations').count(), 0);
  assert.deepEqual(await state(), before); assert(remote.calls.every(c => c.method === 'GET'));
  report.checks.push('Unreadable Manifest reports its diagnostic and review/repair guidance without any executable plan or delete prompt');
  await close();
}
