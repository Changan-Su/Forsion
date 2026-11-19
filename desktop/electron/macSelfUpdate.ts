/**
 * mac 能不能在应用内自装更新(Squirrel.Mac)。
 *
 * Squirrel.Mac 换包前会核对:新包的签名必须满足**正在运行的这个包**的指定要求(designated requirement)。
 *  - Developer ID 签名的包:要求是「同一团队的 Developer ID 证书」→ 下一版只要还是这个团队签的就换得过去。
 *  - ad-hoc 签名的旧包(2.14 之前发的都是):要求钉死在自己的 cdhash 上,任何新包都满足不了 → 只能浏览器开 .dmg 手动装。
 * 另外 Squirrel 要能改写 .app 所在目录:从 .dmg 里直接运行、被 Gatekeeper 搬进 AppTranslocation、装在没写权限的地方,都装不上。
 *
 * 只看这台机器上**当前运行的包**,不看版本号(别写死「≥ 2.14 才行」:自己打的 ad-hoc 包也会是新版本号)。
 */
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** `codesign -dv --verbose=2 <app>` 的输出(它写在 stderr)→ 是不是 Developer ID 正式签名。 */
export function isDeveloperIdSignature(out: string): boolean {
  if (/^Signature=adhoc$/m.test(out)) return false
  const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim()
  return !!team && team !== 'not set' && /^Authority=Developer ID Application: /m.test(out)
}

/** 可执行文件路径(…/X.app/Contents/MacOS/X)→ .app 本体;不在 .app 里回 null。 */
export function appBundleOf(exe: string): string | null {
  const bundle = resolve(exe, '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

function codesignInfo(bundle: string): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) fail(err)
      else ok(`${stdout}\n${stderr}`)
    })
  })
}

/** 当前运行的包能不能走 Squirrel.Mac 自装。任何一步判不出来都当「不能」(退回 .dmg,不会更糟)。 */
export async function probeMacSelfInstall(exe: string): Promise<{ ok: boolean; reason: string }> {
  const bundle = appBundleOf(exe)
  if (!bundle) return { ok: false, reason: 'not-in-app-bundle' }
  if (bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'translocated' }
  try {
    await access(dirname(bundle), constants.W_OK)
    await access(bundle, constants.W_OK)
  } catch { return { ok: false, reason: 'read-only' } }
  try {
    return isDeveloperIdSignature(await codesignInfo(bundle)) ? { ok: true, reason: 'developer-id' } : { ok: false, reason: 'not-developer-id' }
  } catch { return { ok: false, reason: 'codesign-failed' } }
}
