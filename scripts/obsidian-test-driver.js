// Test-only plugin for the isolated test-vault. Never shipped.
import { Plugin } from 'obsidian';
import { StatefulPreviewService } from '../src/sync/StatefulPreviewService';
import { PreviewModal } from '../src/ui/PreviewModal';
import { obsidianVaultReader } from '../src/vault/ObsidianVaultReader';
import { VaultScanner } from '../src/vault/VaultScanner';
import { IgnoreService } from '../src/vault/IgnoreService';
import { gitBlobSha } from '../src/vault/HashService';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';

export default class Driver extends Plugin {
  onload() {
    const app = this.app;
    let active;
    const api = {
      calls: [], lastResult: undefined, scenario: 'fixture',
      open: async (payload, scenario = 'fixture', localLimit) => {
        active?.close(); api.lastResult = undefined; api.scenario = scenario;
        const plugin = app.plugins.plugins['local-mirror-sync'];
        const options = { owner: 'fixture-owner', repository: 'test-repository', branch: 'main', includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 10 };
        let reader = obsidianVaultReader(app.vault);
        const rules = '*.mp3\n*.m4a\n*.wav\n*.aac\n*.flac\n*.ogg\n*.opus';
        const ignore = new IgnoreService({ configDir: app.vault.configDir, includeObsidian: false, gitignore: rules, patterns: '' });
        if (localLimit !== undefined) {
          const original = reader;
          const scan = await new VaultScanner(reader).scan(ignore);
          const allowed = new Set(scan.files.slice(0, localLimit).map(file => file.path));
          reader = { ...original, list: async path => { const listing = await original.list(path); return { ...listing, files: listing.files.filter(file => allowed.has(file)) }; } };
        }
        const remoteFiles = payload.tree.tree.filter(e => e.type === 'blob');
        const files = Object.fromEntries(remoteFiles.map((e, i) => [`fixture-${i}`, { fileId: `fixture-${i}`, path: e.path, blobSha: e.sha, deleted: false, revision: 1 }]));
        const manifest = { schemaVersion: 1, generation: 37, files };
        let state = { schemaVersion: 1, deviceId: plugin.syncState.current().deviceId };
        if (!['new', 'legacy', 'empty', 'invalid'].includes(scenario)) {
          const baseFiles = Object.fromEntries(Object.entries(files).filter(([, e]) => !e.path.startsWith('历史/')));
          state = { ...state, target: { owner: options.owner, repository: options.repository, branch: options.branch },
            baseManifest: { schemaVersion: 1, generation: 36, files: structuredClone(baseFiles) }, localFiles: {} };
          for (const [id, entry] of Object.entries(baseFiles)) {
            if (entry.path.startsWith('已删除/')) state.localFiles[id] = { ...entry, deleted: true };
            if (entry.path.startsWith('知识库/')) state.localFiles[id] = { ...entry, path: entry.path.replace('指标体系 ', '指标体系设计 ') };
          }
        }
        if (scenario === 'conflict') {
          const entry = Object.values(manifest.files).find(e => e.path.startsWith('修改/'));
          entry.blobSha = 'd'.repeat(40); entry.revision++;
        }
        if (scenario === 'unchanged') {
          const scan = await new VaultScanner(reader).scan(ignore);
          manifest.files = Object.fromEntries(scan.files.map((f, i) => [`same-${i}`, { fileId: `same-${i}`, path: f.path, blobSha: f.sha, deleted: false, revision: 1 }]));
          state = { ...state, baseManifest: structuredClone(manifest), localFiles: {} };
        }
        const manifestText = JSON.stringify(scenario === 'invalid' ? { schemaVersion: 99 } : manifest);
        const manifestBytes = new TextEncoder().encode(manifestText);
        const manifestSha = gitBlobSha(manifestBytes);
        const baseTree = structuredClone(payload.tree);
        if (['conflict', 'unchanged'].includes(scenario)) {
          baseTree.tree = baseTree.tree.filter(e => e.type === 'tree');
          const dirs = new Set(baseTree.tree.map(e => e.path));
          for (const entry of Object.values(manifest.files)) {
            const parts = entry.path.split('/');
            for (let i = 1; i < parts.length; i++) {
              const path = parts.slice(0, i).join('/');
              if (!dirs.has(path)) { baseTree.tree.push({ path, type: 'tree', mode: '040000', sha: 'c'.repeat(40) }); dirs.add(path); }
            }
            baseTree.tree.push({ path: entry.path, sha: entry.blobSha, type: 'blob', mode: '100644', size: 1 });
          }
        }
        if (!['legacy', 'empty', 'missing'].includes(scenario)) baseTree.tree.push(
          { path: '.local-mirror-sync', type: 'tree', mode: '040000', sha: 'c'.repeat(40) },
          { path: MANIFEST_PATH, type: 'blob', mode: '100644', sha: manifestSha, size: manifestBytes.length });
        const transport = async request => {
          api.calls.push({ method: request.method, url: request.url });
          if (api.scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 500));
          if (api.scenario === 'error') return { status: 403, json: {} };
          if (request.url.includes('/ref/')) return { status: 200, json: payload.ref };
          if (request.url.includes('/commits/')) return { status: 200, json: payload.commit };
          if (request.url.includes('/blobs/')) return { status: 200, json: { sha: manifestSha, size: manifestBytes.length, encoding: 'base64', content: btoa(String.fromCharCode(...manifestBytes)) } };
          return { status: 200, json: baseTree };
        };
        const service = new StatefulPreviewService(reader, transport, app.vault.configDir, () => state);
        active = new PreviewModal(app, options, async (progress, signal) => {
          const result = await service.preview(options, '', progress, signal); api.lastResult = result; return result;
        });
        active.open();
      },
      close: () => active?.close(),
    };
    window.__lmsTest = api;
  }
  onunload() { window.__lmsTest?.close(); delete window.__lmsTest; }
}
