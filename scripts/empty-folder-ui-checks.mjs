import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyEmptyFolders({ page, remote, report, runDir, preview, sync, close, state, getUI, WritableVault, LocalStateStore, SyncService, options }) {
  const screenshot = async name => {
    await page.evaluate(() => app.workspace.leftSplit.expand());
    const tree = page.locator('.nav-files-container');
    await tree.waitFor({ state: 'visible' });
    await tree.screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`);
    await page.evaluate(() => app.workspace.leftSplit.collapse());
  };
  await page.evaluate(() => {
    const service = app.plugins.plugins['local-mirror-sync'].sync;
    const execute = service.execute.bind(service);
    service.execute = async (...args) => { try { return await execute(...args); } catch (error) { window.__folderError = error.stack; throw error; } };
  });
  const runSync = sync;
  sync = async () => { try { await runSync(); } catch (error) { report.folderError = await page.evaluate(() => window.__folderError); throw error; } };
  await page.evaluate(async () => {
    await app.vault.createFolder('old/nested');
    await app.vault.createBinary('old/nested/item.md', new TextEncoder().encode('folder test').buffer);
    await app.vault.createFolder('intentional-empty');
  });
  await preview(); await sync(); await close();
  const bVault = new WritableVault();
  const bState = new LocalStateStore({ read: () => bVault.readInternal('state'), write: s => bVault.writeInternal('state', s) });
  await bState.load();
  const bSync = new SyncService(bVault, remote.transport, '.obsidian', bState);
  const bRun = async () => bSync.execute(await bSync.preview(options, 'fixture'), 'fixture');
  await bRun();
  bVault.files.set('new/item.md', new TextEncoder().encode('folder test'));
  bVault.files.delete('old/nested/item.md'); await bState.recordRename('old/nested/item.md', 'new/item.md'); await bRun();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.body.classList.add('emulate-mobile'));
  await preview(); await getUI().setViewportSize({ width: 390, height: 844 }); await sync(); await close();
  await page.waitForFunction(() => !app.vault.getAbstractFileByPath('old'));
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('old')), false);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('new/item.md')), 'folder test');
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('intentional-empty')), true);
  await screenshot('empty-folders-rename');
  report.checks.push('Remote rename removes nested empty source directories from disk and Obsidian file tree, preserving unrelated empty directories (mobile emulation)');

  // Recreate only directories to represent an already-completed old-version sync.
  await page.evaluate(async () => { await app.vault.createFolder('old/nested'); });
  const head = remote.head; const generation = (await state()).lastSeenGeneration;
  await preview();
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('old')), true);
  assert((await getUI().locator('.lms-operations').innerText()).includes('Push 0 · Pull 0 · Conflict 0'));
  await sync(); await close();
  await page.waitForFunction(() => !app.vault.getAbstractFileByPath('old'));
  assert.equal(remote.head, head); assert.equal((await state()).lastSeenGeneration, generation);
  report.checks.push('Zero-file-change Sync repairs completed-journal leftovers; Preview is read-only and no GitHub commit or generation is created');

  await page.evaluate(async () => {
    await app.vault.createFolder('old/nested');
    await app.vault.adapter.write('old/nested/.hidden', 'preserve');
  });
  await preview(); await sync(); await close();
  assert.equal(await page.evaluate(() => app.vault.adapter.read('old/nested/.hidden')), 'preserve');
  report.checks.push('Physical hidden child prevents empty-folder cleanup');

  await page.evaluate(async () => {
    await app.vault.adapter.remove('old/nested/.hidden');
    const adapter = app.vault.adapter;
    const original = adapter.rename.bind(adapter);
    window.__folderRename = original;
    adapter.rename = async (path, destination) => {
      if (path === 'old/nested') {
        await adapter.write('old/nested/.concurrent', 'concurrent child');
      }
      return original(path, destination);
    };
  });
  const beforeRace = (await state()).baseRemoteCommit;
  await preview();
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().locator('.lms-error').waitFor();
  assert((await getUI().locator('.lms-error').innerText()).includes('LOCAL_VERIFY_FAILED'));
  assert.equal((await state()).baseRemoteCommit, beforeRace);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('old/nested/.concurrent')), 'concurrent child');
  await close();
  await page.evaluate(async () => {
    app.vault.adapter.rename = window.__folderRename;
    await app.vault.adapter.remove('old/nested/.concurrent');
    const plugin = app.plugins.plugins['local-mirror-sync'];
    await plugin.sync.resume(plugin.settings, 'fixture');
  });
  report.checks.push('Folder quarantine restores a concurrent child created after the emptiness check; no recursive deletion');

  bVault.files.delete('new/item.md'); await bState.recordDelete('new/item.md'); await bRun();
  await preview(); await sync(); await close();
  await page.waitForFunction(() => !app.vault.getAbstractFileByPath('new') && !app.vault.getAbstractFileByPath('old'));
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('new')), false);
  report.checks.push('Remote tombstone removes its empty parent and retries previously occupied historical folders');
  await screenshot('empty-folders-delete');
}
