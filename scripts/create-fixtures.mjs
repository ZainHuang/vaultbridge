import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const local = new Map();
const remote = new Map();
const put = (map, path, value) => map.set(path, typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
const rules = '*.mp3\n*.MP3\n*.m4a\n*.wav\n*.aac\n*.flac\n*.ogg\n*.opus\n';
put(local, '.gitignore', rules); put(remote, '.gitignore', rules);
for (let i = 1; i <= 20; i++) {
  const n = String(i).padStart(2, '0');
  put(local, `新增/Note ${n}.md`, `# New ${n}\n`);
  put(local, `修改/Note ${n}.md`, `# Revised ${n}\r\n中文内容\r\n`);
  put(remote, `修改/Note ${n}.md`, `# Original ${n}\n`);
  put(local, `知识库/指标体系设计 ${n}.md`, `# Renamed ${n}\nStable content\n`);
  put(remote, `知识库/指标体系 ${n}.md`, `# Renamed ${n}\nStable content\n`);
  put(remote, `已删除/Deleted ${n}.md`, `# Deleted ${n}\n`);
  put(remote, `历史/Legacy ${n}.md`, `# Remote legacy ${n}\n`);
}
for (let i = 1; i <= 5; i++) {
  put(local, `保留/Note ${i}.md`, `# Keep ${i}\n`);
  put(remote, `保留/Note ${i}.md`, `# Keep ${i}\n`);
}
const attachments = {
  '附件/pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6heEAAAAASUVORK5CYII=', 'base64'),
  '附件/sample.pdf': Buffer.from('%PDF-1.4\n% binary hash fixture\n%%EOF\n'),
  '附件/settings.json': Buffer.from('{"title":"知识库"}\n'),
  '附件/board.canvas': Buffer.from('{"nodes":[],"edges":[]}\n'),
  '附件/empty.bin': Buffer.alloc(0),
  '附件/all-bytes.bin': Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  '附件/bom.txt': Buffer.from('\ufeffBOM\r\n'),
  '附件/long-name-跨设备知识文件测试-跨设备知识文件测试-跨设备知识文件测试.bin': Buffer.from([0, 255, 1, 128]),
  '附件/data.dat': Buffer.from([255, 254, 253, 0, 1]),
  '附件/table.csv': Buffer.from('name,value\r\n甲,1\r\n'),
};
for (const [path, value] of Object.entries(attachments)) put(local, path, value);
const audio = ['one.mp3', 'two.MP3', 'three.m4a', 'four.wav', 'five.aac', 'six.flac', 'seven.ogg', 'eight.opus', 'nine.mp3', 'ten.M4A'];
audio.forEach((name, i) => put(local, `音频/${name}`, Buffer.from([i, 0, 255])));

const treeSha = 'b'.repeat(40); const head = 'a'.repeat(40);
const dirs = new Set();
for (const path of remote.keys()) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}
const entries = [...dirs].sort().map(path => ({ path, type: 'tree', mode: '040000', sha: 'c'.repeat(40) }));
for (const [path, bytes] of remote) entries.push({ path, type: 'blob', mode: '100644', size: bytes.length,
  sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });

for (const [base, files] of [['test-vault', local], ['test-repository/files', remote]]) {
  for (const [path, bytes] of files) {
    const file = join(root, base, path); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, bytes);
  }
}
const repository = join(root, 'test-repository');
await mkdir(repository, { recursive: true });
await writeFile(join(repository, 'ref.json'), JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: head } }, null, 2));
await writeFile(join(repository, 'commit.json'), JSON.stringify({ sha: head, tree: { sha: treeSha } }, null, 2));
await writeFile(join(repository, 'tree.json'), JSON.stringify({ sha: treeSha, tree: entries, truncated: false }, null, 2));
await writeFile(join(repository, 'expected.json'), JSON.stringify({ counts: { ADD: 30, UPDATE: 20, DELETE: 40, RENAME: 20, UNCHANGED: 6, IGNORED: 10, CONFLICT: 0 }, operationCounts: { ADD_REMOTE: 50, UPDATE_REMOTE: 20, DELETE_REMOTE: 60 }, eligibleLocal: 76, eligibleRemote: 86 }, null, 2));
console.log(`Created isolated test-vault (${local.size} files) and test-repository (${remote.size} files). No real vault or GitHub writes.`);
