import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const licenses = (await Promise.all([
  readFile('node_modules/@noble/hashes/LICENSE', 'utf8'),
  readFile('node_modules/ignore/LICENSE-MIT', 'utf8'),
])).join('\n\n');

const result = await build({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  platform: 'browser', format: 'cjs', target: 'es2020', outfile: 'main.js',
  sourcemap: false, treeShaking: true, metafile: true,
  define: { process: 'undefined' },
  banner: { js: `/* ${manifest.name} ${manifest.version} | Verified stateful three-way sync */\n/*! Bundled third-party licenses: @noble/hashes and ignore\n${licenses}\n*/` },
});
const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
if (imports.some(item => item.path !== 'obsidian')) throw new Error('Unexpected runtime external dependency');
const output = await readFile('main.js', 'utf8');
if (/\b(?:Buffer|child_process|simple-git)\b|require\(["'](?:node:|fs["']|crypto["'])/.test(output)) throw new Error('Node-only API in mobile bundle');
await mkdir('dist/vaultbridge', { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, `dist/vaultbridge/${file}`);
await writeFile('dist/build-meta.json', JSON.stringify(result.metafile, null, 2));
console.log(`Built mobile-safe bundle (${output.length} chars); external: obsidian only.`);
