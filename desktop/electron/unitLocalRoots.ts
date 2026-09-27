/**
 * /unit/host{file,dir,stat} 的「会话根」只认**本机确认过**的项目目录(Codex 终审 out1 #2 / 评审 D1)。
 *
 * 旧口径:可读根 = 工作区 ∪ vault ∪ **所有 host 会话的 project_path**。project_path 远端改得动 ——
 *   · 远端 PATCH /agent/sessions/:id 改一个本机会话的 project_path(引擎不给它盖远程标记);
 *   · 远端 POST /agent/sessions 新建(引擎盖 agent_config.remoteOrigin);
 *   · 远端 run 带 mentionedProjects → start_project_session 派生一个新会话(引擎同样不盖标记)。
 * 受保护清单(unitHostScope.ts)只能枚举「已知的」凭据目录;把 project_path 改成 ~/Library/Application Support/<某浏览器>/Default
 * 这类不在清单里的目录,远端就能不起 run、不答审批地读走 Login Data / Cookies。
 *
 * 新口径:会话根必须同时满足 ——
 *   ① 该会话**没有**远程标记(agent_config.remoteOrigin);
 *   ② realpath(project_path) 落在某个**本机根**里(含相等):默认工作区 / vault / Coding Studio 项目根 / 本机登记表。
 * 本机登记表只由远端碰不到的动作写入:本机原生目录选择框(dialog:pickDirectory,设备页没有这个桥)与一次性种子
 * (升级后第一次拿到引擎时,把当时已有的、无远程标记的会话目录收进来 —— 种子完成前 unitWeb 对远端的 /engine 一律 503,
 * 远端没有窗口抢在种子之前改 project_path)。登记表存 userData 下的独立文件,不在 config:set / /unit/config 能写的配置里。
 * 刻意零 electron 依赖:vitest 经真 unitWeb 走「远端 PATCH project_path → /unit/hostfile」整链(electron/unitHostChain.test.ts)。
 */
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writePrivateJson, createSerialQueue } from './configWrite'
import { filterSessionRoots, isWithin, type UnitScopeEnv, type UnitScopeGuard } from './unitHostScope'

export interface SessionRowLike { project_path?: unknown; agent_config?: unknown }

/** 会话行带远程标记(引擎在远端建 / 分支的会话上盖 agent_config.remoteOrigin;存值可能是 JSON 串)。 */
export function hasRemoteOrigin(row: SessionRowLike): boolean {
  let cfg: unknown = row?.agent_config
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { return false } }
  return !!cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg as Record<string, unknown>).remoteOrigin != null
}

const realOrNull = (p: string): string | null => { try { return realpathSync(p) } catch { return null } }

/** 无远程标记的会话的 project_path(realpath 后、去重;目录已删的跳过)。 */
export function unmarkedProjectPaths(rows: SessionRowLike[]): string[] {
  const out = new Set<string>()
  for (const row of rows) {
    if (hasRemoteOrigin(row) || typeof row?.project_path !== 'string' || !row.project_path) continue
    const real = realOrNull(row.project_path)
    if (real) out.add(real)
  }
  return [...out]
}

/**
 * 应用数据区:别的软件的配置 / 登录库 / Cookie 住的地方(~/Library 除 iCloud Drive 与 CloudStorage 网盘、Windows AppData、
 * Linux ~/.local/share、~/.var、~/snap、~/.mozilla …)。一次性种子**不收**落在这里的历史会话目录(Codex r3 #1):
 * 升级前远端 PATCH 过、或远端 run 派生出来的会话都没有远程标记,种子分不出来 —— 别的软件的数据目录正是那种攻击的落点,
 * 而真项目几乎不住这里。用户真要把项目开在这里,经「添加项目」的原生选择框登记即可(显式登记不受此限)。
 */
export function inAppDataArea(
  real: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // 会话路径是 realpath 过的:家目录 / 数据目录本身是软链(或 Windows 联接)时,两种形态都得认,否则真实位置漏判(Codex r3 二轮)
  const forms = (p: string | undefined): string[] => (p ? [...new Set([p, realOrNull(p) ?? p])] : [])
  const under = (p: string | undefined): boolean => forms(p).some((f) => isWithin(real, f, platform))
  const homes = forms(home)
  if (platform === 'darwin') {
    return homes.some((h) => {
      const lib = join(h, 'Library')
      return under(lib) && !under(join(lib, 'Mobile Documents')) && !under(join(lib, 'CloudStorage'))
    })
  }
  // Windows:重定向过的 %APPDATA% / %LOCALAPPDATA% 也算(浏览器、各应用的配置都跟着它走)
  if (platform === 'win32') return homes.some((h) => under(join(h, 'AppData'))) || under(env.APPDATA) || under(env.LOCALAPPDATA)
  // Linux 等:XDG 数据目录(缺省 ~/.local/share,可被 XDG_DATA_HOME 挪走)+ Flatpak / Snap / 老式浏览器目录
  return homes.some((h) => ['.local/share', '.var', 'snap', '.mozilla', '.thunderbird', '.pki'].some((d) => under(join(h, d)))) || under(env.XDG_DATA_HOME)
}

/** 种子候选:无远程标记的会话目录,去掉应用数据区里的(见 inAppDataArea)。 */
export function seedCandidates(rows: SessionRowLike[], home: string, platform: NodeJS.Platform = process.platform): string[] {
  return unmarkedProjectPaths(rows).filter((r) => !inAppDataArea(r, home, platform))
}

/** 会话根 = 无远程标记 且 realpath 落在某个本机根里(含相等)。localRoots 须已 realpath、已过 filterSessionRoots。 */
export function confirmedSessionRoots(rows: SessionRowLike[], localRoots: string[], platform: NodeJS.Platform = process.platform): string[] {
  return unmarkedProjectPaths(rows).filter((r) => localRoots.some((l) => isWithin(r, l, platform)))
}

/** 本机登记表:本机确认过的项目根(realpath 后)+ 一次性种子是否已做。 */
export interface LocalProjectRegistry {
  /** 读盘(幂等;读失败 = 空表、未种子)。其余方法前先 await 它。 */
  ready(): Promise<void>
  roots(): string[]
  seeded(): boolean
  /** 本机动作登记(原生目录选择框的结果);realpath 不了的跳过。 */
  add(paths: string[]): Promise<void>
  /** 种子:并入 paths 并记下「已种子」(之后不再种)。 */
  markSeeded(paths: string[]): Promise<void>
}

interface RegistryFile { v: 1; seeded: boolean; roots: string[] }

/** 登记表落 userData 下的独立 JSON(0600,原子写)。add / markSeeded 自己先读盘、在串行队列里「读当前值 → 合并 → 写」:
 *  没先 ready() 就登记(unit 互联没开时选择框照样会登记)不会拿空表盖掉已有的登记与种子标记,并发登记也不互相覆盖。 */
export function createFileProjectRegistry(file: string): LocalProjectRegistry {
  let state: RegistryFile = { v: 1, seeded: false, roots: [] }
  let loaded: Promise<void> | null = null
  const queue = createSerialQueue()
  const ready = (): Promise<void> => (loaded ??= readFile(file, 'utf8').then((raw) => {
    const j = JSON.parse(raw) as Partial<RegistryFile>
    state = { v: 1, seeded: j.seeded === true, roots: Array.isArray(j.roots) ? j.roots.filter((x): x is string => typeof x === 'string') : [] }
  }).catch(() => { /* 没有 / 坏了 = 空表、未种子(种子会补上) */ }))
  const update = (fn: (cur: RegistryFile) => RegistryFile): Promise<void> => queue(async () => {
    await ready()
    const next = fn(state)
    await writePrivateJson(file, next)
    state = next
  })
  const merge = (cur: string[], extra: string[]): string[] => {
    const set = new Set(cur)
    for (const p of extra) { const real = realOrNull(p); if (real) set.add(real) }
    return [...set]
  }
  return {
    ready,
    roots: () => state.roots,
    seeded: () => state.seeded,
    add: (paths) => update((cur) => ({ ...cur, roots: merge(cur.roots, paths) })),
    markSeeded: (paths) => update((cur) => ({ v: 1, seeded: true, roots: merge(cur.roots, paths) })),
  }
}

/** 原生目录选择框的结果:只有「添加 / 导入项目」(opts.purpose === 'project')才登记为本机项目根。
 *  技能导入 / 同步目录 / 额外可写根也走同一个选择框 —— 选了个目录不等于同意设备页浏览它(Codex r3 #2)。true = 已登记。 */
export async function registerPickedDirectory(registry: LocalProjectRegistry, dir: string, opts: unknown): Promise<boolean> {
  if ((opts as { purpose?: unknown } | null | undefined)?.purpose !== 'project') return false
  await registry.add([dir])
  return true
}

export interface EngineAccess { url: string | null; token: string; remoteMark?: string }

export interface UnitSessionRootsSource {
  /** host 会话行(引擎 /agent/sessions,本机令牌;ttl 缓存;引擎没起 / 拉取失败 = 空)。 */
  rows(): Promise<SessionRowLike[]>
  /** 一次性种子;完成(或已完成)= true。引擎未就绪 / 拉取失败 = false(下次再试,连败 maxSeedFailures 次后按空表完成)。 */
  ensureSeeded(): Promise<boolean>
  seeded(): boolean
  invalidate(): void
}

export function createUnitSessionRoots(deps: {
  engine: () => EngineAccess
  registry: LocalProjectRegistry
  ttlMs?: number
  fetchImpl?: typeof fetch
  log?: (m: string) => void
  /** 种子连败上限:到了就按空表完成(安全侧:只剩工作区 / vault / 选择框登记的根),不让设备页永远 503。缺省 5。 */
  maxSeedFailures?: number
  /** 失败后至少隔这么久才再试(远端请求一来一个触发,别在一瞬间把连败次数刷满)。缺省 2000ms。 */
  seedRetryMs?: number
  /** 种子排除应用数据区用(缺省 os.homedir() / process.platform)。 */
  home?: string
  platform?: NodeJS.Platform
}): UnitSessionRootsSource {
  const ttl = deps.ttlMs ?? 15_000
  const doFetch = deps.fetchImpl ?? fetch
  let cache: { at: number; rows: SessionRowLike[] } = { at: -Infinity, rows: [] }
  let seeding: Promise<boolean> | null = null
  let failures = 0
  let lastFailureAt = -Infinity
  const list = async (url: string, token: string, archived: boolean): Promise<SessionRowLike[]> => {
    const r = await doFetch(`${url}/agent/sessions?limit=500${archived ? '&archived=true' : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = (await r.json()) as unknown
    return (Array.isArray(d) ? d : ((d as { sessions?: unknown[] })?.sessions ?? [])) as SessionRowLike[]
  }
  return {
    rows: async () => {
      if (Date.now() - cache.at < ttl) return cache.rows
      let rows: SessionRowLike[] = []
      const { url, token } = deps.engine()
      if (url) { try { rows = await list(url, token, false) } catch { /* 引擎不可达 = 空集 */ } }
      cache = { at: Date.now(), rows }
      return rows
    },
    seeded: () => deps.registry.seeded(),
    invalidate: () => { cache = { at: -Infinity, rows: [] } },
    ensureSeeded: () => {
      if (deps.registry.seeded()) return Promise.resolve(true)
      return (seeding ??= (async () => {
        try {
          await deps.registry.ready()
          if (deps.registry.seeded()) return true
          const { url, token } = deps.engine()
          if (!url) return false
          if (Date.now() - lastFailureAt < (deps.seedRetryMs ?? 2000)) return false
          try {
            const rows = [...await list(url, token, false), ...await list(url, token, true)]
            await deps.registry.markSeeded(seedCandidates(rows, deps.home ?? homedir(), deps.platform ?? process.platform))
            deps.log?.(`[unit] 本机项目根种子完成(${deps.registry.roots().length} 个)`)
            return true
          } catch (e: any) {
            lastFailureAt = Date.now()
            if (++failures < (deps.maxSeedFailures ?? 5)) return false
            deps.log?.(`[unit] 本机项目根种子连败 ${failures} 次(${e?.message || e}),按空表完成:设备页只可读工作区 / 笔记库 / 本机选过的目录`)
            await deps.registry.markSeeded([]).catch(() => {}) // 写盘也失败:保持未种子(闸继续 503),下次再试
            return deps.registry.seeded()
          }
        } catch {
          return false // 调用方多是 void 触发:这里绝不抛(读盘 / 写盘失败 = 未完成)
        } finally { seeding = null }
      })())
    },
  }
}

/**
 * unitWeb 的 getEngine 包一层:本机项目根的种子没做完之前,对远端一律报「引擎未就绪」(unitWeb 回 503 ENGINE_NOT_READY),
 * 顺手触发种子。否则远端可以抢在种子之前 PATCH 一个本机会话的 project_path,让它被当成「升级前就有的本机目录」收进登记表。
 */
export function seedGatedEngine(engine: () => EngineAccess, source: Pick<UnitSessionRootsSource, 'seeded' | 'ensureSeeded'>): () => EngineAccess {
  return () => {
    const e = engine()
    if (!e.url || source.seeded()) return e
    void source.ensureSeeded()
    return { ...e, url: null }
  }
}

/**
 * /unit/host* 三端点的根:base = 工作区 ∪ vault(本机配置,原样);session = 本机确认过的会话根(见文件头)。
 * 本机根里的根目录 / 家目录 / 受保护目录的祖先一律不算(与会话根同一道过滤):否则一条本机的「家目录会话」
 * 就能让家目录下任何远端改出来的 project_path 都算「在本机根里」。
 */
export async function composeUnitRoots(opts: {
  base: string[]
  /** 本机根的其余来源(Coding Studio 项目根等,已 realpath)。 */
  localExtra?: string[]
  registry: LocalProjectRegistry
  source: UnitSessionRootsSource
  env: Pick<UnitScopeEnv, 'home' | 'platform'>
  guard: UnitScopeGuard
}): Promise<{ base: string[]; session: string[] }> {
  await opts.registry.ready()
  const local = filterSessionRoots([...opts.base, ...(opts.localExtra ?? []), ...opts.registry.roots()], opts.env, opts.guard)
  return { base: opts.base, session: confirmedSessionRoots(await opts.source.rows(), local, opts.env.platform ?? process.platform) }
}
