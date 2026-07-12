/**
 * Forsion 数据目录(原 ~/.tangu,2026-07-05 品牌升级为 ~/.forsion)+ 首启自动迁移。
 * 兼容策略 = 三重保险:
 *  ① 迁移:真目录 ~/.tangu 改名为 ~/.forsion(同卷 rename 瞬时完成,不复制不丢数据);
 *  ② 兼容软链 ~/.tangu → ~/.forsion:CLI/TUI/微信 runtime/第三方插件/文档里硬编码旧路径全部照常;
 *  ③ 子进程 env:desktop spawn 托管后端时显式传 TANGU_HOME=~/.forsion(backendManager),
 *     即使用户删了软链也不会分脑。standalone(纯 CLI 无 desktop)刻意不迁,经软链共享同一真身。
 * 默认工作区 ~/Tangu → ~/Forsion 同法(sessions 表里存的绝对 project_path 经软链继续解析)。
 * TANGU_HOME 已被显式设置(测试/多实例重定向)→ 整体跳过迁移,尊重重定向。
 */
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/** dev 态(!app.isPackaged,main.ts 装载时注入):数据目录与正式版完全隔离,且永不触发迁移。
 *  本模块刻意不 import electron(vitest 直测),由宿主注入。 */
let devMode = false
export function setDevMode(v: boolean): void { devMode = v }
export const isDevMode = (): boolean => devMode

export const forsionHomeDir = (): string =>
  process.env.TANGU_HOME || join(homedir(), devMode ? '.forsion-dev' : '.forsion')
/** 引擎(tangu-agent)数据子目录:spawn 托管后端时 TANGU_HOME 指此,引擎私有数据全在其内。
 *  顶层 ~/.forsion 只留共享域文件(auth/provider-auth/config.json/activity)与 desktop 自有内容。 */
export const tanguDataDir = (): string => join(forsionHomeDir(), 'tangu')
/** 默认本机工作区(会话 host 执行 cwd 兜底)。 */
export const defaultWorkspaceDir = (): string => join(homedir(), devMode ? 'Forsion-Dev' : 'Forsion')

const lstatOrNull = (p: string): ReturnType<typeof lstatSync> | null => {
  try { return lstatSync(p) } catch { return null }
}

/**
 * 单对迁移:oldPath(真目录)→ newPath + 旧位留兼容软链。幂等,可反复调用。
 * ensureNew=true 时新路径缺失也建出来(数据目录需要,保证软链有靶;工作区不建,避免给无本机
 * 会话的用户凭空造 ~/Forsion)。两边都是真目录时以新为准、不动旧、不建链(只警告)。
 */
export function migratePair(oldPath: string, newPath: string, opts: { ensureNew?: boolean; log?: (m: string) => void } = {}): void {
  const log = opts.log ?? console.log
  try {
    const oldSt = lstatOrNull(oldPath)
    if (!existsSync(newPath) && oldSt?.isDirectory()) {
      renameSync(oldPath, newPath)
      log(`[forsion-home] 已迁移 ${oldPath} → ${newPath}`)
    } else if (existsSync(newPath) && oldSt?.isDirectory()) {
      log(`[forsion-home] ⚠️ ${oldPath} 与 ${newPath} 并存:以新路径为准,旧目录未动、不建兼容链(请人工合并后删除旧目录)`)
      return
    }
    if (opts.ensureNew && !existsSync(newPath)) mkdirSync(newPath, { recursive: true })
    if (!lstatOrNull(oldPath) && existsSync(newPath)) {
      // 旧位空缺 + 新目录在 → 建兼容软链(win 用 junction 免管理员)。
      symlinkSync(newPath, oldPath, process.platform === 'win32' ? 'junction' : 'dir')
      log(`[forsion-home] 兼容软链 ${oldPath} → ${newPath}`)
    }
  } catch (e) {
    log(`[forsion-home] 迁移 ${oldPath} 失败(不阻塞启动): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** App 启动最早期调用(先于一切读 config/env 文件)。 */
export function migrateForsionHome(log: (m: string) => void = console.log): void {
  if (process.env.TANGU_HOME) return // 显式重定向 → 不迁
  if (devMode) { log('[forsion-home] dev 模式:数据目录 ~/.forsion-dev(与正式版隔离),跳过迁移'); return }
  const home = homedir()
  migratePair(join(home, '.tangu'), join(home, '.forsion'), { ensureNew: true, log })
  migratePair(join(home, 'Tangu'), join(home, 'Forsion'), { log })
}

/** 顶层 → tangu/ 的引擎私有条目(2026-07-12 两层布局)。共享域(auth.json/provider-auth.json/
 *  config.json/activity/)与 desktop 自有(amadeus/themes/spaces/bin/desktop-local-token)留顶层。 */
const ENGINE_ENTRIES = [
  'agents', 'memory', 'skills', 'plugins', 'plugins-config', 'pgdata',
  'state.db', 'state.db-wal', 'state.db-shm',
  'wechat', 'browser', 'browser-use',
  'providers.json', 'providers.json.bak', 'mcp.json', 'mcp.json.bak',
  'engines.json', 'engine-prefs.json', 'special-agents.json', 'special-agents.json.bak',
  'device.json', 'USER.md', 'worker-key', '.env',
]

/**
 * 顶层引擎条目搬进 <home>/tangu/。纯 rename、不留每项软链(顶层才真干净;旧版桌面降级需手动搬回)。
 * ~/.tangu 兼容软链改指 tangu/——CLI/TUI 与桌面同一真身;纯 standalone 的 ~/.tangu 真目录不受影响
 * (那种机器 desktop 根本没跑过,本函数不会碰它)。幂等;须在 migrateForsionHome 之后、backend
 * spawn/一切引擎文件读取之前调用。dev 家(~/.forsion-dev)同样迁移,只是不动生产的 ~/.tangu 链。
 */
export function migrateEngineData(log: (m: string) => void = console.log, homeOverride?: string): void {
  if (!homeOverride && process.env.TANGU_HOME) return // 显式重定向 → 不迁(override 供测试注入)
  const home = homeOverride || forsionHomeDir()
  const dest = join(home, 'tangu')
  try { mkdirSync(dest, { recursive: true }) } catch { /* 逐项迁移会各自报错 */ }
  for (const name of ENGINE_ENTRIES) {
    const oldPath = join(home, name)
    const newPath = join(dest, name)
    try {
      const st = lstatOrNull(oldPath)
      if (!st || st.isSymbolicLink()) continue // 不存在/已是链 → 不动
      if (existsSync(newPath)) { log(`[forsion-home] ⚠️ ${name} 新旧并存:以 tangu/ 为准,旧条目未动(请人工合并)`); continue }
      renameSync(oldPath, newPath)
      log(`[forsion-home] 引擎数据已迁 ${name} → tangu/${name}`)
    } catch (e) {
      log(`[forsion-home] 迁移 ${name} 失败(不阻塞启动): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (devMode || homeOverride) return // dev 家/测试不碰生产 ~/.tangu 链
  const legacy = join(homedir(), '.tangu')
  try {
    const st = lstatOrNull(legacy)
    if (st?.isSymbolicLink()) {
      rmSync(legacy) // 重指:~/.forsion → ~/.forsion/tangu(CLI 的 tanguHome 经 realpath 归位共享域)
      symlinkSync(dest, legacy, process.platform === 'win32' ? 'junction' : 'dir')
      log(`[forsion-home] 兼容软链 ~/.tangu → ${dest}`)
    } else if (!st) {
      symlinkSync(dest, legacy, process.platform === 'win32' ? 'junction' : 'dir') // 空缺补链(上次重指中断的自愈)
      log(`[forsion-home] 兼容软链 ~/.tangu → ${dest}`)
    }
  } catch (e) {
    log(`[forsion-home] ~/.tangu 软链更新失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}
