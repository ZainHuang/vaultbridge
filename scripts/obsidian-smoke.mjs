import { chromium } from 'playwright';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Test-only Node runner. All writes are under this project's isolated test-vault/profile.
const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const vaultPath = join(root, 'test-vault');
const profile = join(root, '.test-profile');
const resultsPath = join(root, 'test-results');
const endpoint = 'http://127.0.0.1:19327';
await mkdir(resultsPath, { recursive: true });
await mkdir(profile, { recursive: true });
const testPlugin = join(vaultPath, '.obsidian/plugins/local-mirror-sync');
await mkdir(testPlugin, { recursive: true });
await rm(join(testPlugin, 'sync-state.json'), { force: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(root, file), join(testPlugin, file));
await writeFile(join(testPlugin, 'data.json'), JSON.stringify({ owner: 'fixture-owner', repository: 'test-repository', branch: 'main', ignorePatterns: '', includeObsidian: false, deleteSafetyThreshold: 20, localToken: '', secretName: '' }));
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { 'lms-phase1': { path: vaultPath, ts: Date.now(), open: true } } }));

const driverPath = join(vaultPath, '.obsidian/plugins/lms-test-driver');
await mkdir(driverPath, { recursive: true });
await writeFile(join(driverPath, 'manifest.json'), JSON.stringify({ id: 'lms-test-driver', name: 'LMS isolated test driver', version: '0.0.0', minAppVersion: '1.6.0', author: 'Tests', description: 'Test-only dependency injection.', isDesktopOnly: false }));
await build({ entryPoints: ['scripts/obsidian-test-driver.js'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', external: ['obsidian'], define: { process: 'undefined' }, outfile: join(driverPath, 'main.js') });

let startedPid;
try { await fetch(`${endpoint}/json/version`); }
catch {
  const executable = process.env.OBSIDIAN_EXE || (() => { throw new Error('Set OBSIDIAN_EXE to your Obsidian.exe path before running integration tests'); })();
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `$lms = Start-Process -FilePath ${quote(executable)} -ArgumentList @(${quote(`--user-data-dir=${profile}`)},'--remote-debugging-port=19327','--disable-gpu','--no-sandbox') -WindowStyle Hidden -PassThru; $lms.Id`;
  const launched = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (launched.status) throw new Error('Failed to launch isolated Obsidian');
  startedPid = Number(launched.stdout.trim());
}
let browser;
const report = { date: new Date().toISOString(), checks: [], consoleErrors: [], consoleDetails: [], network: [], screenshots: [], isolation: {} };
try {
  for (let i = 0; i < 40; i++) {
    try { browser = await chromium.connectOverCDP(endpoint, { timeout: 1500 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert(browser, 'Isolated CDP endpoint unavailable');
  const page = browser.contexts()[0].pages().find(page => page.url().startsWith('app://obsidian.md/'));
  assert(page, 'Obsidian page unavailable');
  await page.waitForFunction(() => window.app?.vault?.adapter && app.plugins?.setEnable && app.commands && app.workspace?.layoutReady, null, { timeout: 20000 });
  const isolation = await page.evaluate(() => ({ vault: app.vault.adapter.getBasePath(), title: document.title }));
  assert.equal(resolve(isolation.vault), vaultPath, 'Refuse to touch any other Vault');
  report.isolation = { ...isolation, profile };
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { report.consoleErrors.push(message.text()); report.consoleDetails.push({ text: message.text(), location: message.location(), afterCheck: report.checks.length }); } });
  await page.evaluate(async () => {
    await app.plugins.setEnable(true);
    for (const id of ['local-mirror-sync', 'lms-test-driver']) await app.plugins.unloadPlugin(id);
    await app.plugins.loadManifests();
    for (const id of ['local-mirror-sync', 'lms-test-driver']) await app.plugins.enablePlugin(id);
  });
  await page.waitForFunction(() => window.__lmsTest && app.plugins.plugins['local-mirror-sync']);
  const commandIds = await page.evaluate(() => Object.keys(app.commands.commands).filter(key => key.startsWith('local-mirror-sync:')));
  assert.deepEqual(commandIds, ['local-mirror-sync:preview-sync', 'local-mirror-sync:sync', 'local-mirror-sync:verify-sync', 'local-mirror-sync:initialize', 'local-mirror-sync:recover-sync', 'local-mirror-sync:dashboard', 'local-mirror-sync:sync-history']);
  report.checks.push('Production V1 plugin loads; retained preview harness remains read-only');
  const firstDevice = await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].syncState.current());
  assert.equal(firstDevice.schemaVersion, 1);
  assert.equal(firstDevice.baseManifest, undefined);
  assert.match(firstDevice.deviceId, /^[0-9a-f-]{36}$/);
  report.checks.push('First startup persists a random UUID without inventing a synchronized BASE');

  await page.evaluate(() => { app.setting.open(); app.setting.openTabById('local-mirror-sync'); });
  let settingsPage = page;
  for (let index = 0; index < 20; index++) {
    const found = browser.contexts()[0].pages().find(candidate => candidate !== page);
    if (found) { settingsPage = found; break; }
    if (await page.locator('.setting-item input[type="password"]').count()) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const tokenInput = settingsPage.locator('.setting-item input[type="password"]');
  assert.equal(await tokenInput.getAttribute('type'), 'password');
  await tokenInput.fill('lms-test-only-not-a-real-token');
  await settingsPage.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.waitForFunction(() => !!app.plugins.plugins['local-mirror-sync'].settings.secretName);
  const credentialBoundary = await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    return { secretStorage: plugin.tokens.supportsSecrets, localTokenEmpty: plugin.settings.localToken === '', tokenMatches: plugin.tokens.read(plugin.settings) === 'lms-test-only-not-a-real-token' };
  });
  assert.deepEqual(credentialBoundary, { secretStorage:true, localTokenEmpty:true, tokenMatches:true });
  assert(!(await readFile(join(testPlugin, 'data.json'), 'utf8')).includes('lms-test-only-not-a-real-token'));
  await tokenInput.scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: join(resultsPath, 'settings.png') });
  report.screenshots.push('settings.png');
  report.checks.push('Native settings Save uses real Obsidian SecretStorage; data.json has no token; input is masked');
  await page.evaluate(() => { app.setting.close(); document.body.classList.remove('theme-light'); document.body.classList.add('theme-dark'); });
  await page.getByText('VaultBridge settings saved.', { exact: true }).waitFor({ state: 'hidden', timeout: 8000 });

  const payload = Object.fromEntries(await Promise.all(['ref', 'commit', 'tree'].map(async key => [key, JSON.parse(await readFile(`test-repository/${key}.json`, 'utf8'))])));
  const baseline = await digestVault(vaultPath);
  const stateBefore = await readFile(join(testPlugin, 'sync-state.json'), 'utf8');
  const ready = async () => { await page.getByRole('button', { name: 'Refresh Preview', exact: true }).waitFor(); };
  const plan = () => page.evaluate(() => window.__lmsTest.lastResult.plan);
  const screenshot = async name => { await page.screenshot({ path: join(resultsPath, name) }); report.screenshots.push(name); };
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(payload => window.__lmsTest.open(payload, 'loading'), payload);
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  assert(await page.locator('.lms-status').isVisible());
  await screenshot('stateful-loading.png');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('.lms-modal').count(), 0);
  report.checks.push('Loading and cancellation work in the native modal');

  await page.evaluate(payload => window.__lmsTest.open(payload), payload); await ready();
  assert.equal((await plan()).status, 'READY');
  assert.deepEqual(Object.fromEntries(Object.entries((await plan()).counts).filter(([, count]) => count)), {
    PUSH_ADD: 30, PUSH_UPDATE: 20, PUSH_DELETE: 20, PUSH_RENAME: 20, PULL_ADD: 20, UNCHANGED: 6,
  });
  for (const label of ['Push 90', 'Pull 20', 'Conflict 0', 'Bootstrap 0']) assert(await page.getByRole('button', { name: label, exact: true }).isVisible());
  assert.equal(await page.getByRole('button', { name: 'Unchanged 6', exact: true }).count(), 0);
  assert.equal(await page.locator('.lms-entry').count(), 10);
  assert((await page.locator('.lms-subtitle').innerText()).includes('Stateful Three-Way Sync'));
  assert(!(await page.locator('.lms-modal').innerText()).includes('Local Primary'));
  assert(await page.locator('.lms-warning').isVisible());
  await screenshot('stateful-desktop.png');
  report.checks.push('Native fixture: Push 90 / Pull 20 / Unchanged 6, stable-ID rename and explicit deletion history; threshold 10 warning');
  await page.getByRole('button', { name: 'Push 90', exact: true }).click();
  await page.getByRole('searchbox').fill('指标体系 01');
  assert.equal(await page.locator('.lms-entry').count(), 1);
  await page.locator('.lms-entry summary').click();
  assert((await page.locator('.lms-entry').innerText()).includes('PUSH_RENAME'));
  assert((await page.locator('.lms-entry-detail').innerText()).includes('File ID:'));
  await page.getByRole('searchbox').fill('no-such-file');
  assert(await page.getByText('No files match this filter.', { exact: true }).isVisible());
  await page.getByRole('button', { name: 'Refresh Preview', exact: true }).click(); await ready();
  await page.getByRole('button', { name: 'Next 10', exact: true }).click();
  assert.equal(await page.locator('.lms-entry').count(), 10);
  report.checks.push('Group filter, identity/hash details, old-path search, empty filter, refresh and ten-row pagination');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Push 90', exact: true }).click();
  await page.getByRole('searchbox').fill('long-name');
  await page.locator('.lms-entry summary').click();
  assert.equal(await page.locator('.lms-file-modal').count(), 1);
  await page.locator('.lms-file-metadata summary').click();
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.lms-modal, .lms-modal .modal-content, .lms-table-wrap')].map(el => ({ width: el.clientWidth, scroll: el.scrollWidth })));
  assert(overflow.every(item => item.scroll <= item.width + 1), JSON.stringify(overflow));
  await screenshot('stateful-mobile-details.png');
  await page.locator('.lms-file-modal').getByRole('button', { name: 'Back to preview', exact: true }).click();
  await page.locator('.lms-modal .modal-content').evaluate(el => { el.scrollTop = 0; });
  await screenshot('stateful-mobile-top.png');
  report.checks.push('390px viewport fits long Unicode paths, hashes and full directional category labels');
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(() => { document.body.classList.remove('theme-dark'); document.body.classList.add('theme-light'); });
  await screenshot('stateful-light.png');
  await page.evaluate(payload => window.__lmsTest.open(payload, 'error'), payload);
  await page.getByRole('button', { name: 'Retry Preview', exact: true }).waitFor();
  assert((await page.locator('.lms-wrap').innerText()).includes('HTTP_403'));
  assert.equal(await page.locator('.lms-entry').count(), 0);
  await screenshot('stateful-error.png');
  await page.evaluate(() => { window.__lmsTest.scenario = 'fixture'; });
  await page.getByRole('button', { name: 'Retry Preview', exact: true }).click(); await ready();
  assert.equal((await plan()).status, 'READY');
  report.checks.push('HTTP error has no partial plan; explicit Retry rescans and succeeds');

  await page.evaluate(payload => window.__lmsTest.open(payload, 'conflict'), payload); await ready();
  assert.equal((await plan()).counts.CONFLICT_CONTENT, 1);
  await page.getByRole('button', { name: 'Conflict 1', exact: true }).click();
  await page.locator('.lms-entry summary').click();
  assert((await page.locator('.lms-entry-detail').innerText()).includes('Base blob:'));
  await screenshot('stateful-conflict.png');
  report.checks.push('Both-side edit displays CONFLICT_CONTENT with BASE/LOCAL/REMOTE hashes and no winner');

  const largeRemote = { ...payload, tree: { ...payload.tree, tree: Array.from({ length: 245 }, (_, i) => ({ path: `remote-${i}.md`, type: 'blob', mode: '100644', size: 1, sha: 'd'.repeat(40) })) } };
  await page.evaluate(payload => window.__lmsTest.open(payload, 'new', 0), largeRemote); await ready();
  const bootstrap = await plan();
  assert.equal(bootstrap.status, 'BOOTSTRAP_FROM_REMOTE'); assert.equal(bootstrap.remoteGeneration, 37);
  assert.equal(bootstrap.localCount, 0); assert.equal(bootstrap.remoteCount, 245);
  assert.equal(bootstrap.counts.PUSH_DELETE, 0); assert.equal(bootstrap.entries.length, 0); assert.equal(bootstrap.executionAllowed, false);
  await screenshot('stateful-bootstrap-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await screenshot('stateful-bootstrap-mobile.png');
  await page.evaluate(payload => window.__lmsTest.open(payload, 'new', 3), largeRemote); await ready();
  assert.equal((await plan()).status, 'BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY');
  await screenshot('stateful-nonempty-device.png');
  report.checks.push('0/245 generation 37 is Bootstrap with ZERO file operations; 3/245 is a nonempty-device conflict');
  await page.setViewportSize({ width: 1200, height: 900 });
  const emptyRemote = { ...payload, tree: { ...payload.tree, tree: [] } };
  for (const [scenario, expected, data, limit] of [
    ['legacy', 'LEGACY_REMOTE_REQUIRES_ADOPTION', payload, undefined],
    ['empty', 'INITIALIZE_REMOTE_FROM_LOCAL', emptyRemote, 0],
    ['missing', 'REMOTE_MANIFEST_MISSING', payload, undefined],
    ['invalid', 'REMOTE_MANIFEST_INVALID', payload, undefined],
  ]) {
    await page.evaluate(({ data, scenario, limit }) => window.__lmsTest.open(data, scenario, limit), { data, scenario, limit }); await ready();
    assert.equal((await plan()).status, expected); assert.deepEqual((await plan()).entries, []);
  }
  await screenshot('stateful-invalid-manifest.png');
  await page.evaluate(payload => window.__lmsTest.open(payload, 'unchanged'), payload); await ready();
  assert.equal((await plan()).counts.UNCHANGED, 76);
  assert((await page.locator('.lms-status').innerText()).includes('No changes planned'));
  const unchanged = await plan();
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: 'Refresh Preview', exact: true }).click(); await ready();
    assert.deepEqual(await plan(), unchanged);
  }
  report.checks.push('Legacy/empty/missing/invalid gates and 10 repeated unchanged native previews are stable');
  await page.evaluate(() => window.__lmsTest.close());
  assert.deepEqual(await digestVault(vaultPath), baseline);
  assert.equal(await readFile(join(testPlugin, 'sync-state.json'), 'utf8'), stateBefore);
  report.network = await page.evaluate(() => window.__lmsTest.calls);
  assert(report.network.every(call => call.method === 'GET'));
  report.checks.push('All notes, attachments, settings and local sync state remain byte-for-byte unchanged by Preview; all requests are GET');
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); });
  assert.deepEqual(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].syncState.current()), firstDevice);
  report.checks.push('Device UUID survives real plugin reload without creating BASE');

  await page.evaluate(async () => {
    document.body.classList.add('emulate-mobile');
    await app.plugins.unloadPlugin('local-mirror-sync');
    await app.plugins.enablePlugin('local-mirror-sync');
  });
  assert(await page.evaluate(() => !!app.plugins.plugins['local-mirror-sync']));
  report.checks.push('Production bundle loads with Obsidian mobile emulation blocking Node package imports');

  // A real unauthenticated public-repository request through the production command and Obsidian requestUrl.
  if (process.env.LMS_SKIP_LIVE_GITHUB === '1') {
    report.liveGitHub = { status:'not_retried', reason:'Live read explicitly disabled by LMS_SKIP_LIVE_GITHUB. Fixture success is not a successful live read.' };
  } else {
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    plugin.settings = { ...plugin.settings, owner:'obsidianmd', repository:'obsidian-sample-plugin', branch:'master', localToken:'', secretName:'' };
    app.commands.executeCommandById('local-mirror-sync:preview-sync');
  });
  await page.waitForFunction(() => document.querySelector('.lms-summary') || document.querySelector('.lms-error'), null, { timeout: 30000 });
  if (await page.locator('.lms-summary').count()) {
    report.liveGitHub = { status: 'passed', repository: 'obsidianmd/obsidian-sample-plugin', head: await page.locator('.lms-head').filter({ hasText: /^HEAD / }).first().innerText(), operations: await page.locator('.lms-operations').innerText() };
    await page.screenshot({ path: join(resultsPath, 'preview-live-github.png') });
    report.screenshots.push('preview-live-github.png');
  } else report.liveGitHub = { status: 'blocked', error: await page.locator('.lms-wrap').innerText() };
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].previewModal?.close());
  }
  await page.evaluate(() => document.body.classList.remove('emulate-mobile'));
  assert.deepEqual(await digestVault(vaultPath), baseline);
  assert.deepEqual(report.consoleErrors, []);
  report.status = report.liveGitHub.status === 'passed' ? 'passed' : 'passed_with_live_read_pending';
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(resultsPath, 'obsidian-smoke.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  // Close only a process started by this runner; never a user's existing Obsidian process.
  if (startedPid) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${startedPid} -ErrorAction SilentlyContinue`], { windowsHide: true });
  }
}

async function digestVault(base) {
  const entries = [];
  async function walk(dir, relative = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (path !== '.obsidian') await walk(join(dir, entry.name), path); }
      else entries.push([path, createHash('sha256').update(await readFile(join(dir, entry.name))).digest('hex')]);
    }
  }
  await walk(base);
  entries.push(['.obsidian/plugins/local-mirror-sync/data.json', createHash('sha256').update(await readFile(join(testPlugin, 'data.json'))).digest('hex')]);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
