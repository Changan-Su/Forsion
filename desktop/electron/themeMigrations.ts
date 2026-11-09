/**
 * Soft 改为随包内置(frontend/src/theme/themes/soft)之后,磁盘上旧的 <home>/themes/soft/ 怎么办。
 * 纯 fs(不 import electron),主进程启动时 await 一次,vitest 直接测。
 *
 * 旧版 Soft 是首次运行时种进 themes/ 的(electron/seedThemes.ts,只在 themes/ 不存在时写一次,之后永不更新)。
 * 内置项本来就压过磁盘同名主题(registry.mergeDiskThemes),所以:
 * - 磁盘 soft/ 和任一发过的种子逐字一致(CRLF 归一后)= 用户没改过 → 什么都不动,文件留在原地,内置版生效。
 * - 不一致 = 用户改过 → 另存成 soft-custom「Soft(自改)」:目录整个改名(theme.css 一个字节不动),
 *   theme.json 只改身份(名字;id 仍是 'soft',即这份 CSS 写给谁的,读盘时映射到目录名,见 themes.ts);
 *   写一份标记 .soft-migration.json(渲染层据此把正用 soft 的人切到 soft-custom 一次)+ 一行日志。
 * - 读不到 / 解析不了 / 状态说不清 = 不知道 → 什么都不动(读失败 ≠ 没改过,更不能据此改写)。
 * - soft-custom 已经在 → 什么都不动,绝不覆盖。改名之后 soft/ 不在了,再跑一遍什么都不做。
 *
 * 写盘次序:先就地改 theme.json(原子替换),再写标记,最后整目录改名。任何一步之后崩了,下次启动照同一流程续上。
 */
import { createHash, randomBytes } from 'crypto'
import { lstat, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

export const SOFT_ID = 'soft'
export const SOFT_CUSTOM_ID = 'soft-custom'
/** 迁移标记,放在 themes/ 根下;点开头的名字不是合法主题 id,readThemesDir 不会把它当主题。 */
export const SOFT_MIGRATION_MARKER = '.soft-migration.json'
const CUSTOM_NAME = { zh: 'Soft(自改)', en: 'Soft (custom)' }

/**
 * 发过的每一版种子的指纹:sha256(CRLF→LF 后的全文),theme.json 与 theme.css 成对。
 * 来源 = seedThemes.ts 在 git 历史里的每一版求值后的写盘内容(JSON.stringify(manifest, null, 2) + '\n' 与 CSS 常量)。
 */
export const SHIPPED_SOFT_SEEDS: ReadonlyArray<{ commit: string; json: string; css: string }> = [
  // 2026-06-29 v2.0.0 —— 装机上最常见的那版(紫色阴影、22px 卡面圆角)
  { commit: 'b2d9521d3', json: '41aaa1c8d418e8910a164efc477a305ab549c367e8353c0233890999bfb9276b', css: 'b67735112789e335ec85fac4075e0127eff33e554a28b3db7cb3edf443d86494' },
  // 2026-08-25 双轴配色契约
  { commit: 'beb7fefd5', json: '57c0ac970d7203aadd079b7f4cdb5c2ba26ed46be44979cdd89f4a7495cdc638', css: 'fddcafc108e6166feb19b0ff6964ee56cd70f8b8669cef58cee1fff045b197b7' },
  // 2026-09-23 最后一版种子(也是 forsion-theme-soft 目录里那份)
  { commit: '7ba5ac5a1', json: '8e23ed9f2bf8fa3cc08dc4b4c3a0d6cbf50693bc096a7f3625ba8e151d7bf692', css: 'bd54f49e6f14aebc6f12e0cb406e102d02e48ec7c3e12927c3ac6f1ca2adea2c' },
]

export const fingerprint = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/** 这一对文本是不是某一版种子的原样(同一版的 json + css 都对上)。 */
export function isShippedSoft(jsonText: string, cssText: string): boolean {
  const j = fingerprint(jsonText), c = fingerprint(cssText)
  return SHIPPED_SOFT_SEEDS.some((s) => s.json === j && s.css === c)
}

export type SoftMigrationResult =
  | { action: 'none'; reason: 'absent' | 'unknown' | 'unmodified' | 'custom-exists' | 'failed' }
  | { action: 'kept-custom'; from: typeof SOFT_ID; to: typeof SOFT_CUSTOM_ID }

/** css = 迁走的那份 theme.css 的指纹:读盘时只认这份,别人后来建的同名 soft-custom 不算迁移出来的(不会把谁切过去)。 */
export interface SoftMigrationMarker { from: string; to: string; at: string; css: string }

/** 自改副本的 manifest:只换身份。id 固定 'soft'(CSS 写给 [data-theme='soft']),名字换成「Soft(自改)」;
 *  预览卡标题若还是种子的 'Soft' 就去掉(ThemeCard 优先显示 preview.title.text,不去掉会出现两张「Soft」)。其余字段原样。 */
export function customManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, name: _name, nameEn: _nameEn, ...rest } = manifest
  const out: Record<string, unknown> = { id: SOFT_ID, name: CUSTOM_NAME.zh, nameEn: CUSTOM_NAME.en, ...rest }
  const preview = rest.preview
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    const title = (preview as Record<string, unknown>).title
    if (title && typeof title === 'object' && !Array.isArray(title) && (title as Record<string, unknown>).text === 'Soft') {
      const { text: _text, ...titleRest } = title as Record<string, unknown>
      const { title: _title, ...previewRest } = preview as Record<string, unknown>
      out.preview = Object.keys(titleRest).length ? { ...previewRest, title: titleRest } : previewRest
    }
  }
  return out
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code

/** 不存在 → 'absent';存在 → 'present';说不清(权限等) → 'unknown'。不跟随符号链接。 */
async function probe(path: string): Promise<'absent' | 'present' | 'unknown'> {
  try { await lstat(path); return 'present' } catch (e) { return errCode(e) === 'ENOENT' ? 'absent' : 'unknown' }
}

/** 同目录写临时文件再 rename:写到一半断电不会留下半截的 theme.json。
 *  临时名随机 + 独占创建('wx'):碰上同名文件 / 符号链接就失败,不截断也不顺着链接写;只清理自己建出来的那份。 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  let created = false
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
    created = true
    await rename(tmp, file)
  } catch (e) {
    if (created) await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

export async function migrateDiskSoft(
  dir: string,
  opts: { now?: () => Date; log?: (line: string) => void } = {},
): Promise<SoftMigrationResult> {
  const log = opts.log ?? ((line: string) => console.info(line))
  const src = join(dir, SOFT_ID)
  let st
  try { st = await lstat(src) } catch (e) {
    return { action: 'none', reason: errCode(e) === 'ENOENT' ? 'absent' : 'unknown' }
  }
  if (!st.isDirectory()) return { action: 'none', reason: 'unknown' } // 文件 / 符号链接:不是种子写出来的样子,不碰

  let jsonText: string, cssText: string, manifest: unknown
  try {
    jsonText = await readFile(join(src, 'theme.json'), 'utf8')
    cssText = await readFile(join(src, 'theme.css'), 'utf8')
    manifest = JSON.parse(jsonText)
  } catch {
    return { action: 'none', reason: 'unknown' }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { action: 'none', reason: 'unknown' }
  if (isShippedSoft(jsonText, cssText)) return { action: 'none', reason: 'unmodified' }

  const dst = join(dir, SOFT_CUSTOM_ID)
  const there = await probe(dst)
  if (there === 'present') return { action: 'none', reason: 'custom-exists' }
  if (there === 'unknown') return { action: 'none', reason: 'unknown' }

  try {
    await writeAtomic(join(src, 'theme.json'), JSON.stringify(customManifest(manifest as Record<string, unknown>), null, 2) + '\n')
    const marker: SoftMigrationMarker = { from: SOFT_ID, to: SOFT_CUSTOM_ID, at: (opts.now?.() ?? new Date()).toISOString(), css: fingerprint(cssText) }
    await writeAtomic(join(dir, SOFT_MIGRATION_MARKER), JSON.stringify(marker, null, 2) + '\n')
    // 改名前再看一眼:上面两步之间不该有人建 soft-custom,但「绝不覆盖」不能只靠时序。撤掉刚写的标记(它本来也认指纹)。
    if ((await probe(dst)) !== 'absent') {
      await rm(join(dir, SOFT_MIGRATION_MARKER), { force: true }).catch(() => {})
      return { action: 'none', reason: 'custom-exists' }
    }
    await rename(src, dst)
  } catch (e) {
    console.warn('[themes] Soft 自改副本另存失败,下次启动重试:', (e as Error)?.message)
    return { action: 'none', reason: 'failed' }
  }
  log(`[themes] 迁移:themes/${SOFT_ID} 改过,整目录另存为 themes/${SOFT_CUSTOM_ID}(theme.css 原样,theme.json 只改名字);Soft 现随应用内置`)
  return { action: 'kept-custom', from: SOFT_ID, to: SOFT_CUSTOM_ID }
}

/** 读迁移标记;读不到 / 坏了 = 没有(只影响「切一次」这件事,不影响主题本身能不能用)。 */
export async function readSoftMigrationMarker(dir: string): Promise<SoftMigrationMarker | null> {
  try {
    const m = JSON.parse(await readFile(join(dir, SOFT_MIGRATION_MARKER), 'utf8'))
    if (m && typeof m === 'object' && m.from === SOFT_ID && m.to === SOFT_CUSTOM_ID && typeof m.at === 'string' && typeof m.css === 'string') return m as SoftMigrationMarker
  } catch { /* 没有 / 坏了 */ }
  return null
}
