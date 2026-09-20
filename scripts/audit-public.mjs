import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Inspect the actual index (or also the proposed, non-ignored working files).
// Report only file/line/rule, never matched credentials or private content.
const candidates = process.argv.includes('--candidates');
const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', ...(candidates ? ['--others', '--exclude-standard'] : [])], { encoding: 'utf8' }).split('\0').filter(Boolean))];
if (!paths.length) throw new Error('No tracked/public candidate files to audit');
const forbidden = /(?:^|\/)(?:node_modules|artifacts|test-results|test-vault|test-repository|\.test-profile|\.obsidian|\.local-mirror-sync|\.sync-history|dist)(?:\/|$)|(?:^|\/)(?:data|sync-state|device-state|product-state)\.json$|(?:^|\/)\.env(?:\.|$)|(?:\.pem|\.key)$/i;
const rules = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['cloud-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential-url', /https?:\/\/[^\s/<>:@]+:[^\s/<>@]+@/],
  ['personal-machine-path', /(?:[A-Z]:[\\/](?:Users[\\/]admin|projects[\\/]|obsidian_notebook)|obsidian-notebook)/i],
];
const findings = [];
for (const path of paths) if (forbidden.test(path) || /(?:REPORT\.md|INTERNAL_CHANGELOG\.md|PUBLISH_LIFECYCLE_ROOT_CAUSE\.md)$/.test(path)) findings.push({ path, rule: 'private-or-generated-path' });
const bundles = ['main.js', 'dist/vaultbridge/main.js'];
for (const bundle of bundles) if (!existsSync(bundle)) throw new Error(`Missing build: ${bundle}`);
for (const path of [...paths, ...bundles]) {
  const content = candidates || bundles.includes(path) ? readFileSync(path, 'utf8') : execFileSync('git', ['show', `:${path}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  for (const [i, line] of content.split(/\r?\n/).entries()) {
    for (const [rule, pattern] of rules) {
      // The scanner itself contains the private path detection vocabulary.
      if (path === 'scripts/audit-public.mjs' && rule === 'personal-machine-path') continue;
      if (pattern.test(line)) findings.push({ path, line: i + 1, rule });
    }
  }
}
console.log(JSON.stringify({ mode: candidates ? 'public-candidates' : 'git-index', files: paths.length, bundles: bundles.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
