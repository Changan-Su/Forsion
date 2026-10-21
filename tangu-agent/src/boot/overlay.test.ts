import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_ENTRIES, ENGINE_PACKAGE, SCHEMA_FILES, canonicalFiles, checkOverlay, cmpVersion, markBad, readBad, selectOverlay, verifyEngineSignature } from './overlay.js';
import { ENGINE_SIGNING_KEY } from './signingKey.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const DEPS = { express: '^4.18.2', ws: '^8.21.0' };
let tmp: string;
let bundled: string;
let engineRoot: string;

function write(root: string, files: Record<string, string>): void {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), data);
  }
}
const runtimeFiles = (): Record<string, string> => ({
  ...Object.fromEntries(Object.values(ENGINE_ENTRIES).map((rel) => [rel, `// ${rel}\n`])),
  ...Object.fromEntries(SCHEMA_FILES.map((rel) => [rel, `// schema ${rel}\n`])),
});
const pkgJson = (version: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: ENGINE_PACKAGE, version, dependencies: DEPS, forsion: { minDesktop: '2.0.0' }, ...extra });

/** 在 engineRoot/<dirName> 放一份新版并签名;mutate 在签名之前改文件表。 */
function overlay(version: string, opts: { files?: Record<string, string>; key?: typeof privateKey; dirName?: string } = {}): string {
  const dir = path.join(engineRoot, opts.dirName ?? version);
  const files = { 'package.json': pkgJson(version), ...runtimeFiles(), ...opts.files };
  write(dir, files);
  const hashes = Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel, createHash('sha256').update(data).digest('hex')]));
  const sig = sign(null, Buffer.from(canonicalFiles(hashes), 'utf8'), opts.key ?? privateKey).toString('base64');
  write(dir, { SIGNATURE: JSON.stringify({ alg: 'ed25519', files: hashes, sig }) });
  return dir;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'overlay-test-'));
  bundled = path.join(tmp, 'bundled');
  engineRoot = path.join(tmp, 'home', 'engine');
  write(bundled, { 'package.json': pkgJson('2.1.0'), ...runtimeFiles() });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('checkOverlay', () => {
  it('收下签名正确、比自带新、依赖与建表文件都没变的新版', () => {
    expect(checkOverlay(overlay('2.1.1'), bundled, pub)).toEqual({ ok: true, version: '2.1.1' });
  });

  it('不比自带的新就不收', () => {
    expect(checkOverlay(overlay('2.1.0'), bundled, pub)).toMatchObject({ ok: false, code: 'version' });
    expect(checkOverlay(overlay('2.0.9'), bundled, pub)).toMatchObject({ ok: false, code: 'version' });
  });

  it('预发布版本号不收', () => {
    expect(checkOverlay(overlay('2.1.1-rc.1', { dirName: 'rc' }), bundled, pub)).toMatchObject({ ok: false, code: 'version' });
  });

  it('包名不对不收', () => {
    const dir = overlay('2.1.1', { files: { 'package.json': JSON.stringify({ name: 'evil', version: '2.1.1', dependencies: DEPS, forsion: { minDesktop: '2.0.0' } }) } });
    expect(checkOverlay(dir, bundled, pub)).toMatchObject({ ok: false, code: 'package' });
  });

  it('要求的壳版本比这份安装包高,或者没写,都不收', () => {
    expect(checkOverlay(overlay('2.1.1', { files: { 'package.json': pkgJson('2.1.1', { forsion: { minDesktop: '2.1.1' } }) } }), bundled, pub)).toMatchObject({ ok: false, code: 'host' });
    expect(checkOverlay(overlay('2.1.2', { files: { 'package.json': pkgJson('2.1.2', { forsion: undefined }) } }), bundled, pub)).toMatchObject({ ok: false, code: 'host' });
    expect(checkOverlay(overlay('2.1.3', { files: { 'package.json': pkgJson('2.1.3', { forsion: { minDesktop: '2.1.0' } }) } }), bundled, pub)).toMatchObject({ ok: true });
  });

  it('a newer desktop can accept an engine whose version is below the desktop version', () => {
    write(bundled, { 'desktop-host.json': JSON.stringify({ version: '4.0.0' }) });
    const dir = overlay('2.1.1', { files: { 'package.json': pkgJson('2.1.1', { forsion: { minDesktop: '3.0.0' } }) } });
    expect(checkOverlay(dir, bundled, pub)).toEqual({ ok: true, version: '2.1.1' });
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })?.version).toBe('2.1.1');
  });

  it('a newer bundled engine cannot satisfy a higher minimum desktop version', () => {
    write(bundled, { 'desktop-host.json': JSON.stringify({ version: '1.0.0' }) });
    expect(checkOverlay(overlay('2.1.1'), bundled, pub)).toMatchObject({ ok: false, code: 'host' });
  });

  it.each(['{', '{}', '{"version":null}', '{"version":"garbage"}'])('does not fall back on malformed host identity: %s', (data) => {
    write(bundled, { 'desktop-host.json': data });
    expect(checkOverlay(overlay('2.1.1'), bundled, pub)).toMatchObject({ ok: false, code: 'host' });
  });

  it('依赖清单有任何不同都不收', () => {
    const more = overlay('2.1.1', { files: { 'package.json': pkgJson('2.1.1', { dependencies: { ...DEPS, pg: '^8.18.0' } }) } });
    expect(checkOverlay(more, bundled, pub)).toMatchObject({ ok: false, code: 'deps' });
    const bumped = overlay('2.1.2', { files: { 'package.json': pkgJson('2.1.2', { dependencies: { ...DEPS, ws: '^9.0.0' } }) } });
    expect(checkOverlay(bumped, bundled, pub)).toMatchObject({ ok: false, code: 'deps' });
  });

  it.each(SCHEMA_FILES)('建表 / 迁移文件 %s 变了就不收', (rel) => {
    expect(checkOverlay(overlay('2.1.1', { files: { [rel]: '// a new migration\n' } }), bundled, pub)).toMatchObject({ ok: false, code: 'schema' });
  });

  it('别的钥匙签的不收;缺省用的是钉在源码里的那把', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(checkOverlay(overlay('2.1.1', { key: other }), bundled, pub)).toMatchObject({ ok: false, code: 'signature' });
    expect(checkOverlay(overlay('2.1.2'), bundled)).toMatchObject({ ok: false, code: 'signature' });
    expect(ENGINE_SIGNING_KEY).toContain('BEGIN PUBLIC KEY');
  });
});

describe('verifyEngineSignature', () => {
  it('改一个字节、少一个文件、多一个文件都不过', () => {
    const changed = overlay('2.1.1');
    writeFileSync(path.join(changed, ENGINE_ENTRIES.standalone), '// tampered\n');
    expect(verifyEngineSignature(changed, pub)).toMatch(/does not match its signed hash/);

    const missing = overlay('2.1.2');
    rmSync(path.join(missing, SCHEMA_FILES[0]));
    expect(verifyEngineSignature(missing, pub)).toMatch(/is missing/);

    const extra = overlay('2.1.3');
    write(extra, { 'node_modules/express/index.js': 'hijack' });
    expect(verifyEngineSignature(extra, pub)).toMatch(/node_modules\/express\/index\.js is not covered/);
  });

  it.skipIf(process.platform === 'win32')('符号链接一律不过', () => {
    const dir = overlay('2.1.1');
    symlinkSync(path.join(bundled, 'package.json'), path.join(dir, 'dist', 'link.js'));
    expect(verifyEngineSignature(dir, pub)).toMatch(/not a regular file/);
  });

  it('签名表里没有入口或 package.json 不过', () => {
    const dir = path.join(engineRoot, 'partial');
    const files = { 'dist/other.js': 'x' };
    write(dir, files);
    const hashes = { 'dist/other.js': createHash('sha256').update('x').digest('hex') };
    write(dir, { SIGNATURE: JSON.stringify({ alg: 'ed25519', files: hashes, sig: sign(null, Buffer.from(canonicalFiles(hashes)), privateKey).toString('base64') }) });
    expect(verifyEngineSignature(dir, pub)).toMatch(/package\.json is not covered/);
  });

  it('没有 SIGNATURE 或格式不对不过', () => {
    const dir = overlay('2.1.1');
    writeFileSync(path.join(dir, 'SIGNATURE'), '{"alg":"rsa"}');
    expect(verifyEngineSignature(dir, pub)).toMatch(/malformed/);
    rmSync(path.join(dir, 'SIGNATURE'));
    expect(verifyEngineSignature(dir, pub)).toMatch(/no readable SIGNATURE/);
  });
});

describe('selectOverlay', () => {
  it('没有 engine 目录、目录是空的 → null', () => {
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })).toBeNull();
    mkdirSync(engineRoot, { recursive: true });
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })).toBeNull();
  });

  it('挑版本号最高的合格那份;按数值比,不按字符串比', () => {
    overlay('2.1.2');
    overlay('2.1.10');
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })).toMatchObject({ version: '2.1.10', dir: path.join(engineRoot, '2.1.10') });
  });

  it('最高的那份不合格就退到下一份,并报出原因', () => {
    overlay('2.1.2');
    writeFileSync(path.join(overlay('2.1.3'), ENGINE_ENTRIES.tui), '// tampered\n');
    const rejected: string[] = [];
    const picked = selectOverlay(engineRoot, bundled, { publicKeyPem: pub, onReject: (version, code) => rejected.push(`${version}:${code}`) });
    expect(picked?.version).toBe('2.1.2');
    expect(rejected).toEqual(['2.1.3:signature']);
  });

  it('记成坏版本的跳过', () => {
    overlay('2.1.2');
    overlay('2.1.3');
    markBad(engineRoot, '2.1.3', 'crashed on start');
    expect(readBad(engineRoot)).toEqual({ '2.1.3': 'crashed on start' });
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })?.version).toBe('2.1.2');
    markBad(engineRoot, '2.1.2', 'also bad');
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })).toBeNull();
    expect(Object.keys(readBad(engineRoot)).sort()).toEqual(['2.1.2', '2.1.3']);
  });

  it('目录名和里面的版本号对不上的不用;暂存目录等别的名字不看', () => {
    overlay('2.1.5', { dirName: '2.1.4' });
    overlay('2.1.6', { dirName: '.staging-123' });
    const rejected: string[] = [];
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub, onReject: (version, code) => rejected.push(`${version}:${code}`) })).toBeNull();
    expect(rejected).toEqual(['2.1.4:package']);
  });

  it.skipIf(process.platform === 'win32')('版本目录本身是符号链接的不用', () => {
    const real = overlay('2.1.2', { dirName: 'elsewhere' });
    symlinkSync(real, path.join(engineRoot, '2.1.2'));
    expect(selectOverlay(engineRoot, bundled, { publicKeyPem: pub })).toBeNull();
  });
});

describe('cmpVersion', () => {
  it('逐段按数值比', () => {
    expect(cmpVersion('2.13.10', '2.13.9')).toBe(1);
    expect(cmpVersion('2.13.3', '2.13.3')).toBe(0);
    expect(cmpVersion('2.9.99', '2.10.0')).toBe(-1);
  });
});

it('readBad 读到坏文件当作空', () => {
  mkdirSync(engineRoot, { recursive: true });
  writeFileSync(path.join(engineRoot, 'bad.json'), 'not json');
  expect(readBad(engineRoot)).toEqual({});
  writeFileSync(path.join(engineRoot, 'bad.json'), '[1]');
  expect(readBad(engineRoot)).toEqual({});
  expect(readFileSync(path.join(engineRoot, 'bad.json'), 'utf8')).toBe('[1]');
});
