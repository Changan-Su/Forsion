/**
 * 电脑历史 · Windows 侧:找到 CU 包里的 windows-bridge.exe → 按内容哈希拷一份私有副本 → 探协议 → 算管道名 → 拉起常驻录制服务。
 * 订阅、落盘、策略全在 computerHistory.ts(与 macOS 同一条线协议,只是 socket 换成命名管道)。
 *
 * 纪律:
 *  1. **绝不原地运行 CU 包里的 exe**:CU 引擎插件的 setup-helper.mjs 每起一个新引擎进程就把随包 exe 覆盖到
 *     ~/.pi/agent/helpers/tangu-computer-use/windows-bridge.exe,插件目录更新时也会被整目录原子替换 —— 常驻进程占着这些
 *     路径,Windows 上覆盖 / 替换就会失败,Computer Use 随之坏掉。所以拷进 `%LOCALAPPDATA%\tangu-computer-use\recorder\windows-bridge-<h12>.exe`
 *     (h12 = 内容 sha256 前 12 位)再跑;同目录临时名 + rename,存在即视为完整。别的哈希的旧副本尽力删(还在跑的删不掉,
 *     它没了订阅者约 60s 后自己退出,下次再删)。
 *  2. **管道名带用户 + 内容哈希**:命名管道是全机的,快速用户切换下两个用户不能撞;新 exe = 新管道,旧服务没人连自己退出。
 *  3. 协议探测一个哈希只跑一次(内存缓存):打印出版本号、或跑完了却没打印(老 helper:不认子命令,读 stdin 到 EOF 就退)
 *     都是确定的结论,缓存;起不来 / 超时是一时的,不缓存,交给控制器按 disconnected 退避重试。
 *     ⚠️ 探测的 stdin 必须是 ignore:老 helper 忽略 argv、从 stdin 读请求,给它一根开着的管道就会挂到超时。
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activeBundleDir, builtinBundleSources } from './builtinPlugins'

/** 私有副本的目录:%LOCALAPPDATA%\tangu-computer-use\recorder。不放电脑历史根下 —— 「清空数据」整删那棵树时还在跑的 exe
 *  删不掉(服务在最后一个订阅者走后约 60s 才退),会留下半截目录;也不放漫游的 %APPDATA%,更不是 setup-helper 覆盖的 ~/.pi 路径。 */
export function recorderBinDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local'), 'tangu-computer-use', 'recorder')
}

/** 这一次连接要用的 Windows 录制服务(控制器每次连接现取)。 */
export interface WindowsRecorderTarget {
  /** 私有副本(recorderBinDir() 下的 windows-bridge-<h12>.exe),拉起它,不是 CU 包里那份。 */
  exe: string
  /** `\\.\pipe\tangu-computer-use-recorder-<u8>-<h12>` */
  pipe: string
  /** `recorder-protocol` 打印的协议版本;null = 老 helper(没有常驻录制服务)。 */
  protocol: number | null
}

const HELPER_REL = path.join('prebuilt', 'windows', 'windows-bridge.exe')
const COPY_RE = /^windows-bridge-([0-9a-f]{12})\.exe$/
const TMP_RE = /^\.windows-bridge-.*\.tmp$/
export const PROBE_TIMEOUT_MS = 5_000

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 管道名:`<u8>` = 用户名 sha256 前 8 位(不把用户名本身摆进全机可见的管道名里)。 */
export function recorderPipeName(username: string, h12: string): string {
  return `\\\\.\\pipe\\tangu-computer-use-recorder-${sha256Hex(username).slice(0, 8)}-${h12}`
}

function currentUsername(): string {
  try { return os.userInfo().username || process.env.USERNAME || 'user' } catch { return process.env.USERNAME || 'user' }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * 按内容哈希把 source 拷成 `<binDir>/windows-bridge-<h12>.exe`(已在 = 不动);拷贝走同目录临时名 + rename,
 * 中途崩了只留下 `.tmp`,不会出现半截的 exe。cleanup:尽力删别的哈希的旧副本与残留临时文件(EBUSY / EPERM 照忽略)。
 */
export async function stageRecorderExe(source: string, binDir: string, h12: string, cleanup = true): Promise<string> {
  const exe = path.join(binDir, `windows-bridge-${h12}.exe`)
  if (!existsSync(exe)) {
    await mkdir(binDir, { recursive: true })
    const tmp = path.join(binDir, `.windows-bridge-${h12}.${process.pid}-${randomUUID()}.tmp`)
    try {
      await copyFile(source, tmp)
      await rename(tmp, exe)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      if (!existsSync(exe)) throw e // 被别处抢先放好了也算成
    }
  }
  if (cleanup) {
    const names = await readdir(binDir).catch(() => [] as string[])
    await Promise.all(names
      .filter((n) => (COPY_RE.test(n) && n !== path.basename(exe)) || TMP_RE.test(n))
      .map((n) => rm(path.join(binDir, n), { force: true }).catch(() => {}))) // 还在跑的旧副本删不掉:它会自己闲置退出
  }
  return exe
}

/** `<exe> recorder-protocol` → 协议版本;跑完了没打印数字 = null(老 helper)。起不来 / 超时 → reject(不是结论,别缓存)。 */
export function probeRecorderProtocol(exe: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    const child = spawn(exe, ['recorder-protocol'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const finish = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(Object.assign(new Error('recorder-protocol probe timed out'), { code: 'helper_probe_timeout' })))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { if (out.length < 4096) out += c })
    child.once('error', (e) => finish(() => reject(e)))
    child.once('close', () => finish(() => {
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
      resolve(/^\d{1,6}$/.test(first) ? Number(first) : null)
    }))
  })
}

/** 拉起常驻录制服务(同管道名单实例,多余的自己退;最后一个订阅者断开约 60s 后自己退,不需要停)。 */
export function launchWindowsRecorder(exe: string, pipe: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['serve', '--pipe', pipe], { detached: true, stdio: 'ignore', windowsHide: true })
    // 没有 error 监听时,spawn 失败(被杀软拦 / 文件没了)会作为未处理的 'error' 事件打崩主进程
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/**
 * CU 包里的 windows-bridge.exe(源,只读不跑)。选包口径同 desktopPermissions.computerUseInstallerRoot:按清单 id 取
 * tangu-computer-use,候选 [正在生效的已装副本, 随包来源],第一个带 exe 的。PI_COMPUTER_USE_WINDOWS_HELPER_PATH(非空)
 * = 开发者自己构建的 exe,直接当源(照样拷成私有副本再跑)。没有 → null(helper_missing)。
 */
export async function windowsRecorderSource(o: {
  isPackaged: boolean; appPath: string; resourcesPath: string; pluginsRoot: string; env?: NodeJS.ProcessEnv
}): Promise<string | null> {
  const override = (o.env ?? process.env).PI_COMPUTER_USE_WINDOWS_HELPER_PATH?.trim()
  if (override) return existsSync(override) ? path.resolve(override) : null
  const cu = builtinBundleSources({ isPackaged: o.isPackaged, appPath: o.appPath, resourcesPath: o.resourcesPath }).find((s) => s.id === 'tangu-computer-use')
  if (!cu) return null
  for (const dir of [await activeBundleDir(o.pluginsRoot, cu.dir), cu.dir]) {
    const exe = path.join(dir, HELPER_REL)
    if (existsSync(exe)) return exe
  }
  return null
}

/**
 * 控制器的 `windowsRecorder` 依赖:每次连接现取(CU 包可能在运行中被更新换掉)。哈希按 (路径, 大小, mtime) 缓存,
 * 协议按哈希缓存(见文件头 3),旧副本清理每个哈希做一次。
 */
export function createWindowsRecorderResolver(o: {
  binDir: string
  source: () => Promise<string | null>
  username?: () => string
  probe?: (exe: string) => Promise<number | null>
}): () => Promise<WindowsRecorderTarget | null> {
  const hashes = new Map<string, string>()
  const protocols = new Map<string, number | null>()
  const cleaned = new Set<string>()
  const probe = o.probe ?? ((exe: string) => probeRecorderProtocol(exe))
  return async () => {
    const source = await o.source()
    if (!source) return null
    const st = await stat(source).catch(() => null)
    if (!st?.isFile()) return null
    const key = `${source}\u0000${st.size}\u0000${st.mtimeMs}`
    let hash = hashes.get(key)
    if (!hash) {
      hash = await sha256File(source)
      hashes.set(key, hash)
    }
    const h12 = hash.slice(0, 12)
    const exe = await stageRecorderExe(source, o.binDir, h12, !cleaned.has(h12))
    cleaned.add(h12)
    let protocol = protocols.get(h12)
    if (protocol === undefined) {
      protocol = await probe(exe) // reject = 一时起不来,不缓存
      protocols.set(h12, protocol)
    }
    return { exe, pipe: recorderPipeName((o.username ?? currentUsername)(), h12), protocol }
  }
}
