#!/usr/bin/env node
// 打出引擎的 npm 热更新包:暂存 → 裁剪 package.json → 签名 → 回验 → npm pack。先 `npm run build`。
//
//   node scripts/pack-engine.mjs [--version x.y.z] [--min-desktop x.y.z] [--for-desktop x.y.z] [--out <目录>] [--stage-only] [--root <包根>]
//
// --stage-only:只暂存 + 签名,不调 npm 打 tgz(端到端核对用:暂存目录就是装机后的样子,不依赖 npm / tar)。
// --root:从另一份引擎包根取 dist / skills / package.json(端到端核对用;缺省是本脚本所在的这份)。
//
// 包里只有运行要用的东西:dist 下的 .js、skills、agent-skills、LICENSE、package.json、SIGNATURE,
// 外加界面半身(界面热更新 4c):ui/main.js(desktop 的 node scripts/build-tangu-ui.mjs 打出来的,先跑它)+ manifest.json。
// 不改本包 package.json 的 `files` —— server 的 vendor:tangu 靠那份白名单打自己要的 tgz(含类型声明)。
//
// 私钥:环境变量 TANGU_ENGINE_SIGNING_KEY(PEM 文本,CI secret);否则 ~/.forsion-dev/secrets/tangu-engine-signing/key.pem。
// 都没有就报错退出 —— 没签名的包桌面端一律不收,发出去等于发了个装不上的版本(npm 版本不可变)。
// ⚠️ 这把钥匙永不轮换(见 src/boot/signingKey.ts)。
//
// --min-desktop = 这一版最低要哪个版本的桌面壳(通常是它所基于的那个桌面正式版);缺省读 package.json 的 forsion.minDesktop。
// 两处都没有就报错:桌面端只收「比自带的新、且要求的壳版本不高于自己」的引擎,填成本包版本号等于谁都装不上。
//
// --for-desktop = 界面半身是对着哪一版桌面的共享模块表打的(manifest.json 的 forDesktop;桌面端要求恰好等于自己的版本,
// 不等就照用引擎、界面用自带的)。缺省读 ../desktop/package.json 的版本 —— 界面是在这份检出里打的。发版时门禁给出 for_desktop。
import { createHash, createPrivateKey, sign as signBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseReleaseVersion } from '../src/contracts/releaseVersion.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const root = path.resolve(arg('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const fail = (m) => {
  console.error(`::error::${m}`)
  process.exit(1)
}

const overlayJs = path.join(root, 'dist', 'boot', 'overlay.js')
if (!existsSync(overlayJs)) fail('dist/boot/overlay.js is missing; run `npm run build` first.')
const { ENGINE_ENTRIES, SCHEMA_FILES, SIGNATURE_FILE, UI_FILES, canonicalFiles, verifyEngineSignature } = await import(pathToFileURL(overlayJs).href)
if (!UI_FILES) fail('dist/boot/overlay.js predates the UI half; run `npm run build` first.')

const LOCAL_KEY = path.join(os.homedir(), '.forsion-dev', 'secrets', 'tangu-engine-signing', 'key.pem')
function loadPrivateKey() {
  const fromEnv = process.env.TANGU_ENGINE_SIGNING_KEY
  if (fromEnv && fromEnv.trim()) return { key: createPrivateKey(fromEnv), source: 'TANGU_ENGINE_SIGNING_KEY' }
  if (existsSync(LOCAL_KEY)) return { key: createPrivateKey(readFileSync(LOCAL_KEY, 'utf8')), source: LOCAL_KEY }
  return fail(`No signing key: set TANGU_ENGINE_SIGNING_KEY (PEM) or put the key at ${LOCAL_KEY}. Forsion Desktop refuses an unsigned engine.`)
}

const src = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = arg('--version') || src.version
const minDesktop = arg('--min-desktop') || src.forsion?.minDesktop
if (!minDesktop) fail('Pass --min-desktop <x.y.z>: the oldest Forsion Desktop this engine may run on (normally the desktop release it is based on).')
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version ${JSON.stringify(version)} is not a release version (x.y.z).`)
if (!parseReleaseVersion(minDesktop)) fail(`min-desktop ${JSON.stringify(minDesktop)} is not a valid Desktop release version.`)
const desktopPkg = path.join(root, '..', 'desktop', 'package.json')
const forDesktop = arg('--for-desktop') || (existsSync(desktopPkg) ? JSON.parse(readFileSync(desktopPkg, 'utf8')).version : undefined)
if (!forDesktop || !parseReleaseVersion(forDesktop)) fail(`Pass --for-desktop <version>: the Forsion Desktop whose shared module table the UI half was built against (got ${JSON.stringify(forDesktop)}).`)
// 界面半身:必须是 build-tangu-ui.mjs 的产物(严格模式开头、sourceURL 结尾),别把半截文件或别的东西签进去
const UI_SOURCE_URL = '//# sourceURL=forsion-core://tangu/main.js'
const uiSrc = path.join(root, UI_FILES.main)
if (!existsSync(uiSrc)) fail(`${UI_FILES.main} is missing; build the UI half first (cd ../desktop && node scripts/build-tangu-ui.mjs).`)
const uiCode = readFileSync(uiSrc, 'utf8')
if (!uiCode.startsWith('"use strict";') || !uiCode.trimEnd().endsWith(UI_SOURCE_URL)) fail(`${UI_FILES.main} is not a complete build-tangu-ui.mjs bundle (expected "use strict"; … ${UI_SOURCE_URL}).`)
const outDir = path.resolve(arg('--out') || path.join(root, '.engine-pack'))
const stage = path.join(outDir, 'package')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// Runtime .js/.mjs only; declarations and source maps are not needed.
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), {
  recursive: true,
  filter: (from) => !path.basename(from).includes('.') || /\.(?:m?js)$/.test(from),
})
for (const dir of ['skills', 'agent-skills']) cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true })
mkdirSync(path.join(stage, path.dirname(UI_FILES.main)), { recursive: true })
writeFileSync(path.join(stage, UI_FILES.main), uiCode)
writeFileSync(path.join(stage, UI_FILES.manifest), JSON.stringify({ id: 'tangu', main: UI_FILES.main, forDesktop }, null, 2) + '\n')
if (existsSync(path.join(root, 'LICENSE'))) cpSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'))
else if (!process.argv.includes('--stage-only')) fail('LICENSE is missing from the package root.')
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: src.name,
  version,
  license: src.license,
  description: src.description,
  repository: { type: 'git', url: 'git+https://github.com/Changan-Su/Forsion.git', directory: 'tangu-agent' },
  type: src.type,
  main: src.main,
  exports: { '.': './dist/index.js' },
  bin: src.bin,
  files: ['dist', 'skills', 'agent-skills', path.dirname(UI_FILES.main), UI_FILES.manifest, SIGNATURE_FILE],
  dependencies: src.dependencies,
  forsion: { minDesktop },
  publishConfig: { access: 'public' },
}, null, 2) + '\n')

function listFiles(dir, rel = '') {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) return listFiles(dir, child)
    if (e.isFile()) return [child]
    return fail(`${child} is not a regular file; the package may only contain regular files.`)
  })
}
const rels = listFiles(stage)
for (const need of [...Object.values(ENGINE_ENTRIES), ...SCHEMA_FILES, ...Object.values(UI_FILES)]) {
  if (!rels.includes(need)) fail(`${need} is not in the package (stale or partial build?).`)
}
const files = Object.fromEntries(rels.map((rel) => [rel, createHash('sha256').update(readFileSync(path.join(stage, rel))).digest('hex')]))
const { key, source } = loadPrivateKey()
const sig = signBytes(null, Buffer.from(canonicalFiles(files), 'utf8'), key).toString('base64')
writeFileSync(path.join(stage, SIGNATURE_FILE), JSON.stringify({ alg: 'ed25519', files: JSON.parse(canonicalFiles(files)), sig }, null, 2) + '\n')

// 回验用的是桌面端装机时跑的同一个函数、钉在源码里的同一把公钥:拿错钥匙在这里就红,别等装机才发现。
const bad = verifyEngineSignature(stage)
if (bad) fail(`Signed with a key that does not match src/boot/signingKey.ts (${bad}). Key source: ${source}.`)

if (process.argv.includes('--stage-only')) {
  console.log(stage)
  process.exit(0)
}

const packed = JSON.parse(execFileSync('npm', ['pack', stage, '--json', '--ignore-scripts', '--pack-destination', outDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))[0]
// npm 按 files 白名单再筛一遍:tgz 里的文件必须恰好是签过的那些 + SIGNATURE,否则装机时会因「多了 / 少了文件」被拒。
const inTgz = packed.files.map((f) => f.path).sort()
const expected = [...rels, SIGNATURE_FILE].sort()
if (JSON.stringify(inTgz) !== JSON.stringify(expected)) {
  const extra = inTgz.filter((f) => !expected.includes(f))
  const missing = expected.filter((f) => !inTgz.includes(f))
  fail(`The tarball does not match the signed file list. extra: ${extra.join(', ') || '-'}; missing: ${missing.join(', ') || '-'}`)
}
console.log(`${src.name}@${version} (minDesktop ${minDesktop}, UI for desktop ${forDesktop}): ${rels.length} files signed with ${source === 'TANGU_ENGINE_SIGNING_KEY' ? source : 'the local key'}`)
console.log(path.join(outDir, packed.filename))
