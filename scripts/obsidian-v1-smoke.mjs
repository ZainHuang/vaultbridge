import { chromium } from 'playwright';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..'); process.chdir(root);
const runDir = join(root, 'artifacts', `v1-e2e-${Date.now()}`);
const vaultPath = join(runDir, 'vault'); const profile = join(runDir, 'profile');
const pluginDir = join(vaultPath, '.obsidian/plugins/local-mirror-sync');
await mkdir(pluginDir, { recursive: true }); await mkdir(profile, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(root, file), join(pluginDir, file));
await writeFile(join(vaultPath, 'note.md'), '# Original\nWindows note');
await writeFile(join(vaultPath, 'binary.png'), new Uint8Array([0, 1, 255, 7]));
await writeFile(join(vaultPath, '.obsidian/community-plugins.json'), JSON.stringify(['local-mirror-sync']));
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { 'lms-v1': { path: vaultPath, ts: Date.now(), open: true } } }));
const options = { owner: 'test-owner', repository: 'test-repository', branch: 'main', includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
await writeFile(join(pluginDir, 'data.json'), JSON.stringify({ ...options, secretName: '', localToken: 'fixture-token-only' }));
const fixtureModule = join(runDir, 'fixture.mjs');
await build({ entryPoints: ['scripts/v1-fixture-entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: fixtureModule });
const { GitFixture, WritableVault, SyncService, LocalStateStore } = await import(pathToFileURL(fixtureModule).href);
const remote = new GitFixture();
let dropPatchResponses = false;
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const result = await remote.transport({ url: `https://api.github.com/repos/test-owner/test-repository${req.url}`, method: req.method, headers: {}, throw: false, ...(body ? { body } : {}) });
    if (dropPatchResponses && req.method === 'PATCH') { res.destroy(); return; }
    res.writeHead(result.status, { 'Content-Type': 'application/json', ...(process.argv.includes('--publish')
      ? { 'Cache-Control': req.method === 'GET' && req.url.startsWith('/git/ref/') ? 'private, max-age=60' : 'no-store' } : {}) }); res.end(JSON.stringify(result.json));
  } catch { res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
const endpoint = 'http://127.0.0.1:19328';
const report = { date: new Date().toISOString(), vaultPath, checks: [], consoleErrors: [], screenshots: [] };
let browser; let startedPid; let activePage;
try {
  // This suite starts a fresh instance with a unique, generated fixture Vault.
  try { await fetch(`${endpoint}/json/version`); throw new Error('Test port is already occupied; refusing to reuse an unknown Vault'); }
  catch (error) { if (error.message.startsWith('Test port')) throw error; }
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const exe = process.env.OBSIDIAN_EXE || (() => { throw new Error('Set OBSIDIAN_EXE to your Obsidian.exe path before running integration tests'); })();
  const ps = `$lmsv1 = Start-Process -FilePath ${quote(exe)} -ArgumentList @(${quote(`--user-data-dir=${profile}`)},'--remote-debugging-port=19328','--disable-gpu','--no-sandbox') -WindowStyle Hidden -PassThru; $lmsv1.Id`;
  const launch = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  assert.equal(launch.status, 0); startedPid = Number(launch.stdout.trim());
  for (let i = 0; i < 40; i++) { try { browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  assert(browser);
  const page = browser.contexts()[0].pages().find(p => p.url().startsWith('app://obsidian.md/')); assert(page);
  activePage = page;
  let ui = page;
  let viewport = { width: 1200, height: 900 };
  const surface = async selector => {
    for (let i = 0; i < 150; i++) {
      for (const candidate of browser.contexts()[0].pages()) if (await candidate.locator(selector).count().catch(() => 0)) {
        ui = candidate; await ui.setViewportSize(viewport); return ui;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Obsidian surface not found: ${selector}`);
  };
  await page.waitForFunction(() => window.app?.workspace?.layoutReady && app.plugins, null, { timeout: 25000 });
  assert.equal(resolve(await page.evaluate(() => app.vault.adapter.getBasePath())), vaultPath);
  report.consoleDetails = [];
  page.on('pageerror', e => { report.consoleErrors.push(e.message); report.consoleDetails.push({ stack: e.stack, check: report.checks.length }); });
  page.on('console', m => { if (m.type() === 'error') { report.consoleErrors.push(m.text()); report.consoleDetails.push({ text: m.text(), location: m.location(), check: report.checks.length }); } });
  const trust = page.getByRole('button', { name: '信任仓库作者并启用插件', exact: true });
  if (await trust.count()) { await trust.click(); await page.waitForSelector('.modal-container', { state: 'hidden' }); }
  await page.waitForTimeout(1000); // Let Obsidian's initial trust/load transition finish.
  await page.evaluate(async () => { await app.plugins.setEnable(true); await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.loadManifests(); await app.plugins.enablePlugin('local-mirror-sync'); });
  const inject = async () => page.evaluate(api => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    const original = plugin.sync.transport;
    plugin.sync.transport = request => original({ ...request, url: request.url.replace('https://api.github.com/repos/test-owner/test-repository', api) });
  }, apiUrl);
  await inject();
  const commands = await page.evaluate(() => Object.keys(app.commands.commands).filter(x => x.startsWith('local-mirror-sync:')));
  assert.equal(commands.length, 7); report.checks.push('Production plugin retains five V1 commands and adds Dashboard and Sync History');
  const ready = async () => {
    await surface('.lms-summary, .lms-blocking-banner, .lms-error[role="alert"]');
    assert.equal(await ui.locator('.lms-summary, .lms-blocking-banner').count(), 1, await ui.locator('.lms-modal').innerText());
  };
  const preview = async () => { await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync']; plugin.openPreview();
    const modal = plugin.previewModal; const close = modal.onClose.bind(modal);
    modal.onClose = () => { window.__lmsV1Closed = new Error('modal closed').stack; close(); };
    const oldClose = modal.close.bind(modal);
    modal.close = (...args) => { window.__lmsV1CloseCall = new Error('close called').stack; return oldClose(...args); };
  }); await ready(); };
  const close = async () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].previewModal?.close());
  const sync = async () => {
    await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).click();
    await ui.waitForFunction(() => document.querySelector('.lms-error') || document.body.textContent.includes('Sync verified. BASE updated successfully.'), null, { timeout: 30000 });
    assert.equal(await ui.locator('.lms-error').count(), 0, await ui.locator('.lms-modal').innerText());
  };
  const screenshot = async name => { await ui.screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  const localText = path => page.evaluate(path => app.vault.adapter.read(path), path);
  const state = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].syncState.current());

  if (process.argv.includes('--preview-ux')) {
    const { verifyPreviewUX } = await import('./preview-ux-ui-checks.mjs');
    await verifyPreviewUX({ page, remote, report, runDir, preview, close, surface, getUI: () => ui, state });
  } else if (process.argv.includes('--empty-folders')) {
    const { verifyEmptyFolders } = await import('./empty-folder-ui-checks.mjs');
    await verifyEmptyFolders({ page, remote, report, runDir, preview, sync, close, state, getUI: () => ui, WritableVault, LocalStateStore, SyncService, options });
  } else if (process.argv.includes('--details')) {
    const { verifyMobileDetails } = await import('./mobile-details-ui-checks.mjs');
    await verifyMobileDetails({ page, remote, report, preview, sync, close, state, getUI: () => ui, screenshot });
  } else if (process.argv.includes('--keyboard')) {
    const { verifyMobileKeyboard } = await import('./mobile-keyboard-ui-checks.mjs');
    await verifyMobileKeyboard({ page, remote, report, preview, close, state, getUI: () => ui, screenshot });
  } else if (process.argv.includes('--brand')) {
    const { verifyBrand } = await import('./brand-ui-checks.mjs');
    await verifyBrand({ page, remote, preview, execute: sync, close, state, report, screenshot, surface });
  } else if (process.argv.includes('--dashboard')) {
    const { verifyDashboard } = await import('./dashboard-ui-checks.mjs');
    await verifyDashboard({ page, remote, report, runDir, preview, sync, close, state, surface, getUI: () => ui });
  } else if (process.argv.includes('--publish')) {
    const { verifyPublish } = await import('./publish-ui-checks.mjs');
    await verifyPublish({ page, remote, report, runDir, preview, sync, close, state, surface, getUI: () => ui, inject, setDropPatch: value => { dropPatchResponses = value; } });
  } else if (process.argv.includes('--activity')) {
    const { verifyActivity } = await import('./activity-ui-checks.mjs');
    await verifyActivity({ page, remote, report, runDir, preview, close, state, surface, getUI: () => ui });
  } else if (process.argv.includes('--lifecycle')) {
    const { verifyLifecycle } = await import('./lifecycle-ui-checks.mjs');
    await verifyLifecycle({ page, remote, report, runDir, preview, close, state, surface, getUI: () => ui });
  } else if (process.argv.includes('--v114')) {
    const { verifyV114 } = await import('./v114-ui-checks.mjs');
    await verifyV114({ page, remote, report, runDir, preview, close, state, surface, getUI: () => ui });
  } else if (process.argv.includes('--manifest')) {
    const { verifyManifestUI } = await import('./manifest-ui-checks.mjs');
    await verifyManifestUI({ page, remote, report, runDir, preview, close, state, getUI: () => ui });
  } else if (process.argv.includes('--v113')) {
    const { verifyV113 } = await import('./v113-ui-checks.mjs');
    await verifyV113({ page, remote, report, runDir, preview, close, state, surface, getUI: () => ui, inject });
  } else if (process.argv.includes('--v112')) {
    const { verifyV112 } = await import('./v112-ui-checks.mjs');
    await verifyV112({ page, remote, report, runDir, preview, close, state, surface, getUI: () => ui, inject });
  } else if (process.argv.includes('--v111')) {
    const { verifyV111 } = await import('./v111-ui-checks.mjs');
    await verifyV111({ page, remote, report, runDir, preview, sync, close, state, surface, getUI: () => ui, inject, setDropPatch: value => { dropPatchResponses = value; } });
  } else if (process.argv.includes('--v11')) {
    const { verifyV11 } = await import('./v11-ui-checks.mjs');
    await verifyV11({ page, remote, report, runDir, preview, sync, close, screenshot, state });
  } else {
  await preview(); assert((await ui.locator('.lms-operations').innerText()).includes('Push 2')); await screenshot('01-initialize'); await sync();
  assert.equal((await state()).baseManifest.generation, 1); assert.equal(remote.text('note.md'), '# Original\nWindows note'); await screenshot('02-verified');
  report.checks.push('Initial upload publishes one tree+Manifest commit and verifies real Vault BASE');
  const bVault = new WritableVault(); const bState = new LocalStateStore({ read: () => bVault.readInternal('state'), write: s => bVault.writeInternal('state', s) }); await bState.load();
  const bSync = new SyncService(bVault, remote.transport, '.obsidian', bState);
  const bRun = async () => bSync.execute(await bSync.preview(options, 'fixture'), 'fixture');
  await bRun(); bVault.files.set('note.md', new TextEncoder().encode('# Remote update')); await bRun();
  await close(); await page.evaluate(async () => { await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('note.md')); });
  await preview(); await screenshot('03-pull'); await sync(); assert.equal(await localText('note.md'), '# Remote update');
  assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('markdown')[0]?.view.file?.path), 'note.md');
  report.checks.push('Remote Markdown update uses Obsidian atomic process and preserves the active editor identity');
  bVault.files.set('renamed.md', new TextEncoder().encode('# Rename plus edit')); bVault.files.delete('note.md'); await bState.recordRename('note.md', 'renamed.md'); await bRun();
  await close(); viewport = { width: 390, height: 844 }; await preview();
  assert(await ui.locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1)); await screenshot('04-mobile-rename'); await sync();
  assert.equal(await localText('renamed.md'), '# Rename plus edit'); assert.equal(await page.evaluate(() => app.vault.adapter.exists('note.md')), false);
  report.checks.push('390px real Obsidian viewport: remote rename+edit, binary attachment and contained overflow');
  await close(); await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('renamed.md'), '# Local conflict'); });
  bVault.files.set('renamed.md', new TextEncoder().encode('# Remote conflict')); await bRun();
  await preview(); assert.equal(await ui.locator('.lms-execute').isDisabled(), true); await ui.locator('.lms-entry').filter({ hasText: 'CONFLICT_CONTENT' }).locator('summary').click();
  await ui.getByRole('button', { name: 'Inspect both versions', exact: true }).click(); await surface('.lms-compare');
  await ui.waitForFunction(() => document.querySelector('.lms-compare')?.textContent.includes('# Remote conflict')); await screenshot('05-mobile-conflict-inspection');
  await ui.locator('.lms-file-modal').getByRole('button', { name: 'Use REMOTE', exact: true }).click(); await ready(); await sync();
  assert.equal(await localText('renamed.md'), '# Remote conflict'); report.checks.push('Conflict blocks execution; pinned content inspection and explicit REMOTE resolution work');
  await close(); bVault.files.delete('renamed.md'); await bState.recordDelete('renamed.md'); await bRun();
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].settings.deleteSafetyThreshold = 0; }); await preview();
  await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await ui.getByRole('textbox', { name: 'Delete confirmation' }).fill('DELETE 1'); await screenshot('06-mobile-delete-confirmation');
  await ui.getByRole('button', { name: 'Confirm & Sync', exact: true }).click();
  await ui.getByText('Sync verified. BASE updated successfully.').waitFor();
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('renamed.md')), false); report.checks.push('Remote tombstone deletes real local file only after exact threshold confirmation');
  await close(); bVault.files.set('fresh.md', new TextEncoder().encode('# Bootstrap')); await bRun();
  // Only this generated disposable fixture Vault is cleared, using Obsidian's file API.
  await page.evaluate(async expected => {
    if (app.vault.adapter.getBasePath().replaceAll('\\', '/') !== expected.replaceAll('\\', '/')) throw new Error('Vault mismatch');
    const plugin = app.plugins.plugins['local-mirror-sync'];
    for (const file of app.vault.getFiles()) if (!file.path.startsWith('.')) await app.vault.delete(file);
    await plugin.metadataPending;
    await plugin.syncState.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
  }, vaultPath);
  await preview(); await screenshot('07-bootstrap'); await sync(); assert.equal(await localText('fresh.md'), '# Bootstrap');
  report.checks.push('New device with empty Vault downloads existing Manifest and files without remote deletions');
  await close(); viewport = { width: 1200, height: 900 };
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('fresh.md'), '# Published before disconnect'); });
  dropPatchResponses = true; await preview(); await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await ui.waitForSelector('.lms-error'); await screenshot('08-interrupted'); const beforeRecovery = await state();
  dropPatchResponses = false;
  assert.equal(remote.text('fresh.md'), '# Published before disconnect');
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery());
  await surface('.lms-device-actions .mod-cta');
  await ui.getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor(); await screenshot('09-recovery-after-reload');
  await ui.getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await surface('.lms-summary');
  assert((await state()).baseManifest.generation > beforeRecovery.baseManifest.generation); report.checks.push('Lost PATCH response retains journal; real plugin reload resumes the same commit and advances BASE only after Verify');
  await ui.keyboard.press('Escape');
  await page.evaluate(() => app.commands.executeCommandById('local-mirror-sync:verify-sync')); await ready(); assert.equal(await ui.locator('.lms-execute').count(), 0);
  await screenshot('10-verify-readonly'); report.checks.push('Verify command is read-only with no Sync button');
  await close(); await page.evaluate(async () => { document.body.classList.add('emulate-mobile'); await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); });
  assert(await page.evaluate(() => !!app.plugins.plugins['local-mirror-sync'].sync)); report.checks.push('V1 production bundle reloads with Obsidian mobile emulation');
  await inject(); viewport = { width: 390, height: 844 };
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('fresh.md'), '# Mobile push'); });
  await preview(); await sync(); assert.equal(remote.text('fresh.md'), '# Mobile push');
  await bRun(); bVault.files.set('fresh.md', new TextEncoder().encode('# Desktop reply')); await bRun();
  await preview(); await sync(); assert.equal(await localText('fresh.md'), '# Desktop reply'); await screenshot('11-mobile-push-pull');
  report.checks.push('Mobile emulation executes both Push and Pull through the same production API and real local Vault');

  // Exercise adoption through production buttons in this generated disposable Vault.
  for (const side of ['local', 'remote']) {
    await close(); viewport = side === 'local' ? { width: 1200, height: 900 } : { width: 390, height: 844 };
    const local = { 'local.md': 'local only', 'shared.md': 'local version', 'same.md': 'same', 'skip.log': 'local ignored' };
    const initialRemote = { 'remote.md': 'remote only', 'shared.md': 'remote version', 'same.md': 'same', 'skip.log': 'remote ignored' };
    remote.external(initialRemote); const originalHead = remote.head;
    await page.evaluate(async ({ expected, local }) => {
      if (app.vault.adapter.getBasePath().replaceAll('\\', '/') !== expected.replaceAll('\\', '/')) throw new Error('Vault mismatch');
      const plugin = app.plugins.plugins['local-mirror-sync'];
      for (const file of app.vault.getFiles()) if (!file.path.startsWith('.')) await app.vault.delete(file);
      for (const [path, value] of Object.entries(local)) await app.vault.create(path, value);
      await plugin.metadataPending;
      await plugin.syncState.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
      plugin.settings.ignorePatterns = '*.log'; plugin.settings.deleteSafetyThreshold = 0;
    }, { expected: vaultPath, local });
    const callCount = remote.calls.length;
    await preview();
    assert.equal(await ui.getByRole('button', { name: 'Use Local', exact: true }).count(), 1);
    assert.equal(await ui.getByRole('button', { name: 'Use Remote', exact: true }).count(), 1);
    assert.equal(await ui.getByRole('button', { name: 'Conflict 1', exact: true }).count(), 1);
    assert(await ui.getByRole('button', { name: 'Adopt & Verify', exact: true }).isDisabled());
    await screenshot(`12-${side}-legacy-choice`);
    const choice = side === 'local' ? 'Use Local' : 'Use Remote'; const phrase = `USE ${side.toUpperCase()}`;
    await ui.getByRole('button', { name: choice, exact: true }).click();
    assert.equal(await ui.getByRole('button', { name: 'Conflict 0', exact: true }).count(), 1);
    assert((await ui.locator('.lms-adoption-impact').innerText()).includes(side === 'local' ? 'Delete remote 1' : 'Remove from active Vault 1'));
    assert.equal(await ui.locator('.lms-execute').isDisabled(), false);
    await ui.getByRole('button', { name: 'Adopt & Verify', exact: true }).click();
    const confirmation = ui.getByRole('textbox', { name: 'Adoption confirmation', exact: true });
    await confirmation.fill(phrase.toLowerCase()); assert(await ui.getByRole('button', { name: 'Confirm & Adopt', exact: true }).isDisabled());
    await confirmation.fill(phrase); assert.equal(await ui.getByRole('button', { name: 'Confirm & Adopt', exact: true }).isDisabled(), false);
    await ui.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Switching authority recalculates impact; reopening requires fresh text.
    await ui.getByRole('button', { name: side === 'local' ? 'Use Remote' : 'Use Local', exact: true }).click();
    assert.equal(await ui.getByRole('textbox', { name: 'Adoption confirmation' }).count(), 0);
    await ui.getByRole('button', { name: choice, exact: true }).click();
    await ui.getByRole('button', { name: 'Adopt & Verify', exact: true }).click();
    assert.equal(await ui.getByRole('textbox', { name: 'Adoption confirmation' }).inputValue(), '');
    await ui.getByRole('textbox', { name: 'Adoption confirmation' }).fill(phrase);
    assert(await ui.locator('.lms-confirm-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert(remote.calls.slice(callCount).every(c => c.method === 'GET'));
    await ui.locator('.lms-execute').scrollIntoViewIfNeeded();
    await screenshot(`13-${side}-adoption-confirm`);
    await ui.getByRole('button', { name: 'Confirm & Adopt', exact: true }).click();
    await ui.waitForFunction(() => document.querySelector('.lms-error') || document.body.textContent.includes('Sync verified. BASE updated successfully.'), null, { timeout: 30000 });
    assert.equal(await ui.locator('.lms-error').count(), 0, await ui.locator('.lms-modal').innerText());
    assert.equal((await state()).baseManifest.generation, 1);
    const desired = side === 'local' ? local : initialRemote;
    for (const path of ['local.md', 'remote.md', 'shared.md', 'same.md']) {
      assert.equal(await page.evaluate(path => app.vault.adapter.exists(path), path), path in desired);
      assert.equal(path in remote.contents(), path in desired);
      if (path in desired) { assert.equal(await localText(path), desired[path]); assert.equal(remote.text(path), desired[path]); }
    }
    assert.equal(await localText('skip.log'), 'local ignored'); assert.equal(remote.text('skip.log'), 'remote ignored');
    assert([...remote.refs.values()].includes(originalHead));
    const t = await page.evaluate(async () => {
      const entries = await app.vault.adapter.list('.local-mirror-sync/transactions');
      const journals = [];
      for (const dir of entries.folders) if (dir.split('/').pop() !== 'objects') {
        const path = dir + '/journal.json';
        if (await app.vault.adapter.exists(path)) journals.push(JSON.parse(JSON.parse(await app.vault.adapter.read(path)).payload));
      }
      return journals.find(t => t.adoptionChoice && t.originalState.deviceId === app.plugins.plugins['local-mirror-sync'].syncState.current().deviceId);
    });
    assert(t && t.phase === 'complete'); assert.equal(t.backupRef, `refs/heads/local-mirror-sync-backup/${t.id}`);
    const savedBytes = await page.evaluate(sha => app.vault.adapter.read(`.local-mirror-sync/transactions/objects/blobs/${sha}`), t.before['shared.md']);
    assert.equal(Buffer.from(savedBytes, 'base64').toString(), 'local version');
    await ui.getByRole('button', { name: 'Preview again', exact: true }).click(); await ready();
    assert.equal(await ui.locator('.lms-adoption-choices').count(), 0);
    assert.equal(await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).count(), 1);
    assert((await ui.locator('.lms-operations').innerText()).includes('Push 0 · Pull 0 · Conflict 0'));
    await ui.getByRole('searchbox', { name: 'Filter by path', exact: true }).fill('no-such-file'); assert.equal(await ui.locator('.lms-empty').count(), 1);
    await screenshot(`14-${side}-stateful-after-adoption`);
    report.checks.push(`${choice}: real production UI confirmation, exact mirror, generation 1, GitHub backup ref and local recovery readback; global choices disappear and empty filtering works (${viewport.width}px)`);
  }
  }
  assert.deepEqual(report.consoleErrors, []);
  report.network = { get: remote.calls.filter(c => c.method === 'GET').length, post: remote.calls.filter(c => c.method === 'POST').length, patch: remote.calls.filter(c => c.method === 'PATCH').length, forceTrue: remote.calls.some(c => c.body?.force === true) };
  report.status = 'passed';
} catch (error) {
  if (activePage) {
    report.surfaces = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async p => ({ url: p.url(), modals: await p.locator('.lms-modal').count().catch(() => -1), title: await p.title().catch(() => '') })));
    report.ui = await activePage.locator('.modal-container').allTextContents().catch(() => []);
    report.debug = await activePage.evaluate(() => ({ closeCall: window.__lmsV1CloseCall, closed: window.__lmsV1Closed, html: app.plugins.plugins['local-mirror-sync']?.previewModal?.contentEl?.outerHTML, stopped: app.plugins.plugins['local-mirror-sync']?.sync?.stopped })).catch(() => ({}));
    await activePage.screenshot({ path: join(runDir, 'failure.png') }).catch(() => {});
  }
  report.requestsBeforeFailure = remote.calls.map(c => ({ method: c.method, resource: c.resource }));
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error);
} finally {
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/v1-obsidian.json'), JSON.stringify({ ...report, runDir }, null, 2));
  if (browser) await browser.close();
  if (startedPid) spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${startedPid} -ErrorAction SilentlyContinue`], { windowsHide: true });
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(report, null, 2));
