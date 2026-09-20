import { describe, expect, it, vi } from 'vitest';
import { gitBlobSha } from '../src/vault/HashService';
import { IgnoreService } from '../src/vault/IgnoreService';
import { VaultScanner } from '../src/vault/VaultScanner';
import { bytes, MemoryVault, referenceSha } from './helpers';

const makeIgnore = (gitignore = '', patterns = '', includeObsidian = false, configDir = '.obsidian') => new IgnoreService({ gitignore, patterns, includeObsidian, configDir });

describe('Git blob fingerprints', () => {
  it.each(['', 'hello\n', '中文📝\r\n', '\ufeff# title\n', 'a'.repeat(1_000_001)])('matches independent Node crypto case %#', value => {
    expect(gitBlobSha(bytes(value))).toBe(referenceSha(bytes(value)));
  });
  it('matches known empty Git blob and binary containing every byte', () => {
    expect(gitBlobSha(bytes(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    const raw = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 256));
    expect(gitBlobSha(raw)).toBe(referenceSha(raw));
    expect(gitBlobSha(bytes('x\r\n'))).not.toBe(gitBlobSha(bytes('x\n')));
  });
});

describe('Ignore', () => {
  it.each(['a.mp3', '目录/A.MP3', 'a.m4a', 'a.wav', 'a.aac', 'a.flac', 'a.ogg', 'a.opus'])('supports audio %s', path => {
    expect(makeIgnore('*.mp3\n*.m4a\n*.wav\n*.aac\n*.flac\n*.ogg\n*.opus').reason(path)).toBeTruthy();
    expect(makeIgnore().reason(path)).toBeUndefined();
  });
  it('supports ordered negation, globstar, root anchoring, escaped # and directory parents', () => {
    const ignore = makeIgnore('# comment\n/root.txt\n**/temp/*.json\ncache/\n\\#literal\n*.md', '!keep.md');
    expect(ignore.reason('keep.md')).toBeUndefined();
    expect(ignore.reason('note.md')).toBeTruthy();
    expect(ignore.reason('root.txt')).toBeTruthy();
    expect(ignore.reason('nested/root.txt')).toBeUndefined();
    expect(ignore.reason('x/temp/a.json')).toBeTruthy();
    expect(ignore.reason('cache/deep/file.bin')).toBeTruthy();
    expect(ignore.reason('#literal')).toBeTruthy();
    expect(makeIgnore('cache/\n!cache/keep.md').reason('cache/keep.md')).toBeTruthy();
  });
  it.each(['.git/config', '.trash/a.md', '.obsidian/cache/secret', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/plugins/local-mirror-sync/data.json', '.OBSIDIAN/Plugins/LOCAL-MIRROR-SYNC/manifest.json'])('hard-protects %s despite negation', path => {
    expect(makeIgnore('', '!**\n!.obsidian/**', true).reason(path)).toBeTruthy();
  });
  it('supports include configuration and custom config directory without exposing itself', () => {
    expect(makeIgnore().reason('.obsidian/appearance.json')).toBeTruthy();
    expect(makeIgnore('', '', true).reason('.obsidian/appearance.json')).toBeUndefined();
    expect(makeIgnore('', '!**', true, 'config').reason('config/plugins/local-mirror-sync/main.js')).toBeTruthy();
    expect(makeIgnore('', '', false, 'config').reason('config/appearance.json')).toBeTruthy();
  });
});

describe('VaultScanner', () => {
  it('reads markdown, binary, JSON, canvas and hidden files; never reads protected or user-ignored contents', async () => {
    const vault = new MemoryVault({ 'A.md': '# A', '图.png': [0, 255, 137, 80], 'a.pdf': '%PDF', 'a.json': '{}', 'a.canvas': '{}', '.gitignore': '*.mp3', '.hidden/x': 'x', 'voice.mp3': [1, 2], '.obsidian/plugins/local-mirror-sync/data.json': 'TOKEN', '.trash/trash.md': 'trash' });
    const before = [...vault.files].map(([path, value]) => [path, referenceSha(value)]);
    const snapshot = await new VaultScanner(vault).scan(makeIgnore('*.mp3'));
    expect(snapshot.files).toHaveLength(7);
    expect(snapshot.ignored).toHaveLength(1);
    expect(snapshot.protectedDirectories).toEqual(['.obsidian', '.trash']);
    expect(vault.reads).not.toContain('voice.mp3');
    expect(vault.reads.some(path => path.includes('data.json'))).toBe(false);
    expect([...vault.files].map(([path, value]) => [path, referenceSha(value)])).toEqual(before);
  });
  it('fails closed on unreadable file', async () => {
    const vault = new MemoryVault({ 'A.md': 'text' });
    vi.spyOn(vault, 'readBinary').mockRejectedValue(new Error('secret header'));
    await expect(new VaultScanner(vault).scan(makeIgnore())).rejects.toMatchObject({ code: 'READ_FAILED' });
  });
  it('fails on added file or size change during scan', async () => {
    const vault = new MemoryVault({ 'A.md': 'text' });
    const read = vault.readBinary.bind(vault);
    vi.spyOn(vault, 'readBinary').mockImplementation(async path => { const result = await read(path); vault.files.set('new.md', bytes('new')); return result; });
    await expect(new VaultScanner(vault).scan(makeIgnore())).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
  });
  it('rejects traversal / inconsistent adapter listing', async () => {
    const vault = new MemoryVault();
    vi.spyOn(vault, 'list').mockResolvedValue({ files: ['../outside'], folders: [] });
    await expect(new VaultScanner(vault).scan(makeIgnore())).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
  it('cancels before reading', async () => {
    const vault = new MemoryVault({ 'A.md': 'A' });
    const control = new AbortController(); control.abort();
    await expect(new VaultScanner(vault).scan(makeIgnore(), undefined, control.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(vault.reads).toEqual([]);
  });
});
