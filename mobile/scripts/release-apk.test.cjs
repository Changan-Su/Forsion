/**
 * 更新检查挑 APK 单测 —— `npm run test:releaseapk`(mobile 目录,不用先 build;CI 在 typecheck 之后跑)。
 *
 * 起因(2026-09-26,手机操控 T2 评审):同一个 GitHub release 里多挂了伴随包 Forsion-Hands-*.apk。
 * 更新检查的 GitHub 兜底原来取「第一个匹配 /-android(-debug)?\.apk$/i 的资产」,CI 当时把伴随包命名成
 * `Forsion-Hands-<ver>-android.apk` —— 正好匹配,且字母序排在 Forsion-Tangu 前面 → 用户被引去装伴随包,
 * 本体永不更新、「有新版本」永远挂着。
 *
 * 两半都要钉:
 *   A. 新客户端的 pickAndroidApk(src/releaseApk.ts)排除 Hands、优先 Forsion-Tangu;
 *   B. **已装机的旧客户端**改不了,只能靠 CI 的资产名 —— 读 .github/workflows/build-desktop.yml 里真正 cp 出来的
 *      文件名,用旧客户端那条正则按两种上传顺序各挑一次,必须挑到本体。改 CI 命名时这里先红。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild') // ponytail: 借 vite 的传递依赖(同 live-island.test.cjs)

const src = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/releaseApk.ts')],
  bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', src)(mod, mod.exports)
const { pickAndroidApk } = mod.exports

/** 已发出去的每个客户端里那一行,逐字照抄(mobileShim.ts 09-26 之前的版本);**别改**,它代表改不动的装机版。 */
const legacyPick = (assets) => (assets || []).find((a) => /-android(-debug)?\.apk$/i.test(String(a?.name || '')))

const asset = (name) => ({ name, browser_download_url: `https://github.com/x/releases/download/v1/${name}` })
const names = (list) => list.map(asset)

const fails = []
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); fails.push(name) }
}

// ── A. 新客户端 ──
check('A1 伴随包排在前面(旧命名)也不挑,挑本体', () => {
  assert.equal(pickAndroidApk(names(['Forsion-Hands-2.12.0-android.apk', 'Forsion-Tangu-2.12.0-android.apk']))?.name,
    'Forsion-Tangu-2.12.0-android.apk')
})
check('A2 debug 包同理', () => {
  assert.equal(pickAndroidApk(names(['Forsion-Hands-2.12.0-android-debug.apk', 'Forsion-Tangu-2.12.0-android-debug.apk']))?.name,
    'Forsion-Tangu-2.12.0-android-debug.apk')
})
check('A3 Hands 大小写不敏感;名里同时带 Forsion-Tangu 也排除', () => {
  assert.equal(pickAndroidApk(names(['forsion-HANDS-2.12.0-android.apk', 'Forsion-Tangu-Hands-2.12.0-android.apk'])), undefined)
})
check('A4 只剩伴随包 → undefined(宁缺不错,调用方就不报新版本)', () => {
  assert.equal(pickAndroidApk(names(['Forsion-Hands-2.12.0.apk', 'Forsion-Hands-2.12.0-android.apk', 'Forsion-2.12.0-arm64.dmg'])), undefined)
})
check('A5 Forsion-Tangu 优先于其他匹配的本体命名', () => {
  assert.equal(pickAndroidApk(names(['Other-2.12.0-android.apk', 'Forsion-Tangu-2.12.0-android.apk']))?.name,
    'Forsion-Tangu-2.12.0-android.apk')
})
check('A6 没有 Forsion-Tangu 时落回第一个非 Hands 的 -android.apk(老 release 命名)', () => {
  assert.equal(pickAndroidApk(names(['Forsion-2.0.5-android.apk']))?.name, 'Forsion-2.0.5-android.apk')
})
check('A7 空 / 非数组 / 缺名字 → undefined,不抛', () => {
  assert.equal(pickAndroidApk(undefined), undefined)
  assert.equal(pickAndroidApk(null), undefined)
  assert.equal(pickAndroidApk({}), undefined)
  assert.equal(pickAndroidApk([{}, null, { name: 42 }]), undefined)
})

// ── B. 旧客户端 × CI 实际产出的资产名 ──
const yml = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/build-desktop.yml'), 'utf8')
// build-android 作业里 cp 出来、再被 `Forsion-*.apk` glob 上传进 release 的全部文件名。
const ciNames = [...yml.matchAll(/cp\s+\S+\.apk\s+"(Forsion-[^"]+\.apk)"/g)].map((m) => m[1])
const handsNames = ciNames.filter((n) => /hands/i.test(n))
const tanguNames = ciNames.filter((n) => /^Forsion-Tangu-/.test(n))
const withVersion = (list, vn) => list.map((n) => n.replace(/\$\{VN\}/g, vn))

check('B0 从 CI 里抽到了本体与伴随包各 release + debug 两个名字(抽取本身没坏,否则 B* 是空转)', () => {
  assert.equal(tanguNames.length, 2, `本体: ${JSON.stringify(tanguNames)}`)
  assert.equal(handsNames.length, 2, `伴随包: ${JSON.stringify(handsNames)}`)
})
for (const vn of ['2.12.0', '0.0.0-ci.123']) {
  check(`B1 CI 伴随包资产名不被旧客户端正则认成本体(VN=${vn})`, () => {
    for (const n of withVersion(handsNames, vn)) assert.equal(legacyPick([asset(n)]), undefined, n)
  })
  check(`B2 CI 本体资产名仍被旧客户端认出(VN=${vn})`, () => {
    for (const n of withVersion(tanguNames, vn)) assert.equal(legacyPick([asset(n)])?.name, n)
  })
  // 同一次构建只出 release 或 debug 一组;两种上传顺序都试(GitHub 资产顺序不作保证)。
  for (const variant of ['release', 'debug']) {
    const pickVariant = (list) => list.filter((n) => (variant === 'debug') === /-debug\.apk$/.test(n))
    const release = withVersion([...pickVariant(handsNames), ...pickVariant(tanguNames)], vn)
    for (const order of [release.slice().sort(), release.slice().sort().reverse()]) {
      check(`B3 旧/新客户端对 CI 实际 release(${variant},顺序 ${order.join(' , ')})都挑到本体`, () => {
        const want = pickVariant(withVersion(tanguNames, vn))[0]
        assert.equal(legacyPick(names(order))?.name, want, 'legacy')
        assert.equal(pickAndroidApk(names(order))?.name, want, 'new')
      })
    }
  }
}

console.log(fails.length ? `\n${fails.length} FAIL` : '\nall PASS')
process.exit(fails.length ? 1 : 0)
