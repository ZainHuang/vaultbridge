import assert from 'node:assert/strict';
import { join } from 'node:path';
import { verifyV112 } from './v112-ui-checks.mjs';

export async function verifyV113(context) {
  const { page, remote, report, runDir, close, state, surface, getUI, inject } = context;
  const pending = await verifyV112(context);
  await close();
  const ui = () => getUI();
  const active = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active());
  const open = async () => {
    await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery());
    await surface('.lms-recovery-dialog'); await ui().locator('.lms-recovery-status').filter({ hasText: /Pending Recovery|No pending sync/ }).waitFor();
  };
  const resume = () => ui().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  const screenshot = async name => { await ui().screenshot({ path: join(runDir, name + '.png') }); report.screenshots.push(name + '.png'); };
  const refs = new Map(remote.refs); const calls = remote.calls.length;
  const oldTree = { ...remote.contents() };
  const manifestPath = '.local-mirror-sync/manifest.json';
  const manifest = structuredClone(pending.manifest);
  const note = Object.values(manifest.files).find(f => f.path === 'note.md');
  note.revision++; note.blobSha = remote.blob(new TextEncoder().encode('# Current synchronized note'));
  manifest.generation++;
  manifest.files.removed = { fileId: 'removed', path: 'removed.md', deleted: true, revision: 2 };
  remote.external({}); Object.assign(remote.contents(), oldTree, { 'note.md': note.blobSha,
    [manifestPath]: remote.blob(new TextEncoder().encode(JSON.stringify(manifest))) });
  const currentHead = remote.head;
  await page.evaluate(async pending => {
    const p = app.plugins.plugins['local-mirror-sync']; await p.sync.transactions.begin(pending);
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Current synchronized note');
    await p.product.failure(new Error('fixture recovery'), true);
  }, pending);
  await open(); await resume();
  await ui().getByText('Recovery completed. Run Preview to inspect the current state.', { exact: true }).waitFor();
  assert.deepEqual((await state()).baseManifest, manifest); assert.equal((await state()).baseRemoteCommit, currentHead);
  assert.equal((await state()).lastSeenGeneration, manifest.generation); assert.equal(await active(), null);
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].product.snapshot().status), 'Healthy');
  await screenshot('v113-01-current-head-complete');
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  await open(); await ui().getByText('No pending sync. You can run Preview again.', { exact: true }).waitFor();
  assert.notEqual(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].product.snapshot().status), 'Recovery Required');
  report.checks.push('Descendant generation 2 fully verified at current HEAD; BASE and tombstones persist across real plugin reload, Recovery Required cleared');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].recoveryModal.close());

  // Another interrupted legacy publication with the same original evidence.
  await page.evaluate(async pending => {
    const p = app.plugins.plugins['local-mirror-sync']; await p.sync.transactions.begin(pending);
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Unpublished local edit');
    await p.product.failure(new Error('fixture recovery'), true);
  }, pending);
  const before = await state();
  await open(); await resume();
  await ui().getByText(/LEGACY_CURRENT_STATE_DIFFERS/).waitFor();
  const fresh = () => ui().getByRole('button', { name: 'Start fresh Preview from current HEAD', exact: true });
  await fresh().waitFor();
  assert.match(await ui().locator('.lms-recovery-status').first().innerText(), /note\.md.*hash differs/);
  assert(await ui().getByRole('button', { name: 'Abort Transaction', exact: true }).isDisabled());
  await ui().setViewportSize({ width: 390, height: 844 });
  assert(await ui().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await fresh().scrollIntoViewIfNeeded(); await screenshot('v113-02-fresh-preview-mobile');

  // A stale fresh button cannot release recovery after divergence.
  remote.head = pending.originalHead;
  await fresh().click(); await ui().getByText(/LEGACY_RECOVERY_DIVERGED/).waitFor();
  assert.equal(await fresh().count(), 0); assert.deepEqual(await state(), before); assert.equal((await active()).id, pending.id);
  await screenshot('v113-03-diverged-blocked');
  report.checks.push('Stale fresh Preview action rechecks ancestry; divergence removes the action and preserves Local, BASE and active recovery');

  remote.head = currentHead;
  const validManifestBlob = remote.contents()[manifestPath];
  remote.contents()[manifestPath] = remote.blob(new TextEncoder().encode('{}'));
  await resume(); await ui().getByText(/REMOTE_MANIFEST_INVALID/).waitFor();
  assert.equal(await fresh().count(), 0); assert.deepEqual(await state(), before); assert.equal((await active()).id, pending.id);
  remote.contents()[manifestPath] = validManifestBlob;
  report.checks.push('Invalid current Manifest blocks Recovery and fresh Preview without advancing BASE');

  await resume(); await fresh().waitFor(); await fresh().click();
  await surface('.lms-summary');
  assert.equal(await active(), null); assert.deepEqual(await state(), before);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# Unpublished local edit');
  assert.match(await ui().locator('.lms-operations').innerText(), /Push 1 · Pull 0 · Conflict 0/);
  assert.equal(await ui().getByRole('button', { name: 'Sync & Verify', exact: true }).count(), 1);
  const audit = await page.evaluate(async id => {
    const p = app.plugins.plugins['local-mirror-sync'];
    return JSON.parse(JSON.parse(await app.vault.adapter.read(`${p.sync.transactions.directory(id)}/journal.json`)).payload);
  }, pending.id);
  assert.equal(audit.phase, 'published'); assert.equal(audit.commit, pending.commit);
  assert.equal(audit.legacyRecovery.action, 'START_FRESH_PREVIEW'); assert.equal(audit.legacyRecovery.head, currentHead);
  assert(audit.legacyRecovery.differences.some(d => d.includes('note.md')));
  assert(await ui().locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await screenshot('v113-04-normal-three-way-preview'); await close();
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  await open(); await ui().getByText('No pending sync. You can run Preview again.', { exact: true }).waitFor();
  assert.notEqual(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].product.snapshot().status), 'Recovery Required');
  assert.equal(remote.head, currentHead); assert.deepEqual(remote.refs, refs); assert(remote.calls.slice(calls).every(c => c.method === 'GET'));
  report.checks.push('Explicit fresh Preview retains published audit, full differences and backups, preserves BASE and local edit, opens ordinary Three-Way Preview, survives reload; all recovery traffic GET-only');
}
