/**
 * 演示舞台 · 父进程这侧(用户那份 Forsion 的主进程)。插件经 ctx.stage 起一份装着演示库的隔离 Forsion,按步骤操作它、
 * 拍全分辨率截图、录视频。方案:仓根 docs/ToBeImproved/沙箱开放给插件方案_2026-11-20;参数与错误码在 shared/pluginStage.ts。
 *
 * 和插件沙箱是同一套进程 / 目录隔离(pluginSandbox.ts 另起一个实例,父目录 <forsionHome>/stages/<插件 id>),区别:
 *  · 不装开发副本、不监视目录;装的是用户已安装插件的**包**(只拷包,插件数据在 plugins-data/ 里,不跟过去)和插件包里的演示库;
 *  · 窗口尺寸、像素密度、主题、语言、时钟按参数定,不跟用户那份走;每次 open 都清空重来;
 *  · engine: 'scripted' 时父进程起一个本机回放服务(stageEngine.ts),舞台的引擎地址指向它。
 *
 * ⚠️ 信任边界:插件代码和宿主跑在同一个渲染层,window.tangu.* 谁都能调。所以这里只收「插件 id + 相对路径」:插件目录、
 *    演示库位置、要拷的插件包都在主进程按 id 自己找、按真实路径核,渲染层给的绝对路径一概不认。确认框也在主进程弹。
 * ⚠️ 本模块不 import electron(单测直跑);确认框、IPC 在 main.ts 接线。
 */
import { constants as fsc } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep, isAbsolute } from 'node:path'
import { effectivePluginId } from '../shared/products'
import { sandboxPaths, type PluginSandbox, type SandboxResult } from './pluginSandbox'
import { defineMainMessages } from './mainI18n'
import {
  sanitizeStageOptions, sanitizeStageRecord, sanitizeStageRect, stageThemeStorage, isStagePluginRef,
  type StageChildInfo, type StageErrorCode, type StageOptions,
} from '../shared/pluginStage'

/** 第一次起舞台的确认框(main.ts 弹)。 */
export const STAGE_MESSAGES = defineMainMessages({
  'main.pluginStage.title': { zh: '演示舞台', en: 'Demo stage' },
  'main.pluginStage.message': { zh: '允许「{name}」打开演示舞台吗？', en: 'Allow "{name}" to open a demo stage?' },
  'main.pluginStage.detail': {
    zh: '演示舞台是另起的一份 Forsion，用来截图和录屏。里面只有这个插件带的演示内容和它点名的插件（{plugins}），不登录，不读你的智库和插件数据。它在后台开一个窗口，用完自动关闭。只问这一次。',
    en: 'A demo stage is a separate copy of Forsion for screenshots and recordings. It only holds the demo content this plugin ships and the plugins it names ({plugins}). It is not signed in and does not read your vault or plugin data. It opens a window in the background and closes when done. You will only be asked once.',
  },
  'main.pluginStage.none': { zh: '无', en: 'none' },
  'main.pluginStage.allow': { zh: '允许', en: 'Allow' },
  'main.pluginStage.deny': { zh: '不允许', en: "Don't allow" },
})

export type StageReply = ({ ok: true } & Record<string, unknown>) | { ok: false; code: StageErrorCode; error: string }

export class StageError extends Error {
  constructor(readonly code: StageErrorCode, message: string) { super(message) }
}
const fail = (code: StageErrorCode, error: string): StageReply => ({ ok: false, code, error })

/** 演示库最多拷多少:够放几十篇演示笔记 + 图片,挡住误把整个项目当 fixture。 */
const FIXTURE_MAX_FILES = 5_000
const FIXTURE_MAX_BYTES = 200 * 1024 * 1024
const ENGINE_SCRIPT_MAX = 2 * 1024 * 1024
/** fixture 的个人日历 human/CALENDAR.db 上限:同真引擎那条接口。 */
const CALENDAR_FIXTURE_MAX = 8 * 1024 * 1024
const PACKAGE_MAX_FILES = 10_000
const PACKAGE_MAX_BYTES = 512 * 1024 * 1024

export interface InstalledPlugin { ref: string; id: string; dir: string; folder: string; name: string; version: string; capabilities: string[] }

/** 在 <forsionHome>/plugins 里按 id(或 market-<uuid> 目录名)找已安装的插件。找不到 = null。 */
export async function findInstalledPlugin(forsionHome: string, ref: string): Promise<InstalledPlugin | null> {
  if (!isStagePluginRef(ref)) return null
  const root = join(forsionHome, 'plugins')
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue
    const dir = join(root, e.name)
    // 安装目录常是软链(开发者把项目链过来):按指向的真实目录认
    const st = await stat(dir).catch(() => null)
    if (!st?.isDirectory()) continue
    const m = await readFile(join(dir, 'manifest.json'), 'utf8').then((s) => JSON.parse(s) as Record<string, unknown>, () => null)
    if (!m) continue
    const id = effectivePluginId(e.name, m.id)
    if (!id || (id !== ref && e.name !== ref)) continue
    const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    const capabilities = Array.isArray(m.capabilities) ? m.capabilities.filter((c): c is string => typeof c === 'string') : []
    return { ref, id, dir: await realpath(dir), folder: e.name, name: str(m.name, 120) || id, version: str(m.version, 40), capabilities }
  }
  return null
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + sep)

/** 插件包里的 fixture 目录 → 真实路径;必须在插件包里面、是目录。 */
export async function resolveFixture(pluginDir: string, rel: string): Promise<string> {
  const root = await realpath(pluginDir)
  const abs = await realpath(join(root, rel)).catch(() => null)
  if (!abs || !within(root, abs)) throw new StageError('fixture-invalid', `fixture "${rel}" is not a folder inside the plugin`)
  if (!(await stat(abs)).isDirectory()) throw new StageError('fixture-invalid', `fixture "${rel}" is not a folder`)
  return abs
}

/** 只拷普通文件和目录:软链一律跳过(指到包外面就是把用户的文件带进舞台),隐藏的 .git / .forsion 也跳过。 */
export async function copyTreePlain(src: string, dest: string, budget = { files: FIXTURE_MAX_FILES, bytes: FIXTURE_MAX_BYTES }, skip: RegExp = /^(\.git|\.forsion|\.DS_Store)$/): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true })
    for (const e of await readdir(from, { withFileTypes: true })) {
      if (skip.test(e.name)) continue
      const a = join(from, e.name), b = join(to, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { await walk(a, b); continue }
      if (!e.isFile()) continue
      const size = (await lstat(a)).size
      files += 1; bytes += size
      if (files > budget.files || bytes > budget.bytes) throw new StageError('fixture-invalid', `the fixture vault is too big (max ${budget.files} files / ${Math.round(budget.bytes / 1024 / 1024)} MB)`)
      await copyFile(a, b)
    }
  }
  await walk(src, dest)
  return { files, bytes }
}

/** 插件包拷进舞台:安装目录本身常是软链(开发者把项目链过来),按它指向的真实目录拷;**里面**的软链一律不跟(Codex 11-20:
 *  包里链到别处的东西会把私人文件带进舞台)。不带 node_modules / .git / .forsion。保留原目录名(market-<uuid> 身份)。 */
export async function copyPluginPackage(p: InstalledPlugin, pluginsDir: string): Promise<void> {
  await mkdir(pluginsDir, { recursive: true })
  await copyTreePlain(p.dir, join(pluginsDir, p.folder), { files: PACKAGE_MAX_FILES, bytes: PACKAGE_MAX_BYTES }, /^(node_modules|\.git|\.forsion|\.DS_Store)$/)
}

/** <forsionHome>/stages 要么还没有,要么是一个真目录(不是软链)。 */
export async function stagesBaseOk(forsionHome: string): Promise<boolean> {
  const st = await lstat(join(forsionHome, 'stages')).catch((e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? 'none' as const : null))
  return st === 'none' || (!!st && st !== null && typeof st === 'object' && st.isDirectory() && !st.isSymbolicLink())
}

/** 每个插件第一次起舞台时问一次;记在 <forsionHome>/stages/.grants.json。读不出来 = 不知道:照样问,也不写回(不拿一个读坏的文件去盖)。 */
export function stageGrants(forsionHome: string) {
  const file = join(forsionHome, 'stages', '.grants.json')
  const read = async (): Promise<Record<string, { at: number }> | null> => {
    // 只认普通文件(链到别处的同意记录不算)
    const st = await lstat(file).catch((e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? 'none' as const : null))
    if (st === 'none') return {}
    if (!st || !st.isFile()) return null
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text == null) return null
    try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
  }
  return {
    // 只认自己的键、且是一条记录(Codex 11-20:id 叫 constructor 的插件会摸到对象原型上的同名属性,当成同意过)
    async has(pluginId: string): Promise<boolean> {
      const g = await read()
      const rec = g && Object.hasOwn(g, pluginId) ? g[pluginId] : null
      return !!rec && typeof rec === 'object' && typeof rec.at === 'number'
    },
    async add(pluginId: string): Promise<void> {
      const cur = await read()
      if (!cur) return
      await mkdir(join(forsionHome, 'stages'), { recursive: true })
      const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, JSON.stringify({ ...cur, [pluginId]: { at: Date.now() } }), { flag: 'wx' }) // 独占新建:不写穿事先放好的软链
      await rename(tmp, file)
    },
  }
}

/**
 * fixture 里的个人日历 human/CALENDAR.db 原文;没有这个文件(或没有 human/)= undefined,交给回放引擎当空日历。
 * 只认插件包里的真目录 + 真文件:human/ 解析后必须还在 fixture 里,文件用 O_NOFOLLOW 打开、在句柄上 fstat 和限量读,
 * 查完到读之间被换成软链 / 大文件也读不出去(Codex 11-21)。除了「不存在」,别的读不到一律报错,不当成空日历。
 */
export async function readFixtureCalendar(fixtureDir: string): Promise<string | undefined> {
  const humanDir = join(fixtureDir, 'human')
  const hst = await lstat(humanDir).catch((e: NodeJS.ErrnoException) => { if (e?.code === 'ENOENT') return null; throw new Error(`human could not be read (${e?.code || e})`) })
  if (!hst) return undefined
  if (!hst.isDirectory()) throw new Error('human must be a real folder in the plugin, not a link or a file')
  const realHuman = await realpath(humanDir)
  if (realHuman !== join(await realpath(fixtureDir), 'human')) throw new Error('human must be a real folder in the plugin, not a link')
  let fh: Awaited<ReturnType<typeof open>>
  try { fh = await open(join(realHuman, 'CALENDAR.db'), fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0)) } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return undefined
    throw new Error(code === 'ELOOP' ? 'human/CALENDAR.db must be a regular file, not a link' : `human/CALENDAR.db could not be read (${code || e})`)
  }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > CALENDAR_FIXTURE_MAX) throw new Error('human/CALENDAR.db must be a regular file up to 8 MB')
    const buf = Buffer.alloc(st.size + 1) // 多留一字节:读的时候又长了也看得出来
    let n = 0
    while (n < buf.length) { const r = await fh.read(buf, n, buf.length - n, n); if (!r.bytesRead) break; n += r.bytesRead }
    if (n > st.size) throw new Error('human/CALENDAR.db must be a regular file up to 8 MB')
    return buf.subarray(0, n).toString('utf8')
  } finally { await fh.close().catch(() => {}) }
}

export interface StageDeps {
  forsionHome(): string
  /** pluginSandbox.ts 的第二个实例:base 'stages'、闲置 5 分钟自停、不广播给沙箱卡。 */
  sandbox: PluginSandbox
  /** 第一次起舞台的确认框(main.ts 弹,挂主窗)。 */
  confirm(owner: { pluginId: string; name: string }, plugins: string[], opts: StageOptions): Promise<boolean>
  /** 脚本回放引擎(stageEngine.ts);script 是 engine.json 解析出来的原始值,calendar 是 human/CALENDAR.db 的文本(有才给),校验都在那边。 */
  startEngine(script: unknown, human?: { calendar?: string }): Promise<{ url: string; token?: string; close(): Promise<void> }>
  log(m: string): void
}

/** 舞台进程回的动作结果(SandboxResult)→ 给插件的形状:做了什么、点到了谁、页面大纲。 */
function actionOf(r: SandboxResult): StageReply {
  if (!r.ok) return fail(r.code === 'no_sandbox' ? 'closed' : 'error', r.error || 'the stage did not answer')
  let action: Record<string, unknown> = {}
  try { const t = JSON.parse(r.text || '{}') as { action?: unknown; command?: unknown }; if (t.action && typeof t.action === 'object') action = t.action as Record<string, unknown> } catch { /* 没有动作段 */ }
  if (r.error) return fail('error', r.error)
  return { ok: true, did: typeof action.did === 'string' ? action.did : '', target: typeof action.target === 'string' ? action.target : '', ...(typeof action.outline === 'string' && action.outline ? { outline: action.outline } : {}) }
}

export function createPluginStage(deps: StageDeps) {
  let owner: string | null = null
  let engine: { close(): Promise<void> } | null = null
  /** 每次 open 成功加一:插件拿到的句柄带着它,重开之后旧句柄(和旧实例停用时的清理)一律不作数(Codex 11-20)。 */
  let gen = 0
  // open / close 排成一队:同一个插件连点两次 open,第二次等第一次落定再换,不会两份回放服务、两个主人交错
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn); chain = p.catch(() => {}); return p }
  const grants = () => stageGrants(deps.forsionHome())

  const dropEngine = async (): Promise<void> => {
    const e = engine
    engine = null
    if (e) await e.close().catch((err) => deps.log(`[plugin-stage] engine close failed: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** 舞台进程产出的文件(截图 / 录像):核过在舞台目录里,读出来、删掉。 */
  async function takeOutput(ownerId: string, p: unknown): Promise<Uint8Array> {
    if (typeof p !== 'string' || !isAbsolute(p)) throw new StageError('error', 'the stage did not hand back a file')
    const root = await realpath(sandboxPaths(deps.forsionHome(), ownerId, 'stages').root)
    const real = await realpath(p)
    if (!within(root, real) || relative(root, real).split(sep)[0] !== 'out') throw new StageError('error', 'the stage handed back a file outside its folder')
    if (!(await lstat(real)).isFile()) throw new StageError('error', 'the stage handed back something that is not a file')
    const bytes = await readFile(real)
    await rm(real, { force: true })
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  async function open(ownerId: string, raw: unknown, locale: 'zh' | 'en'): Promise<StageReply> {
    const parsed = sanitizeStageOptions(raw, { locale })
    if (!parsed.ok) return fail('invalid', parsed.error)
    const opts = parsed.options
    const home = deps.forsionHome()
    const st = deps.sandbox.state()
    if (st.running && owner && owner !== ownerId) return fail('busy', `another plugin (${owner}) is using the stage; try again after it closes`)
    const self = await findInstalledPlugin(home, ownerId)
    if (!self) return fail('unsupported', 'only installed plugins can open a stage (dev copies and the plugin sandbox cannot)')
    // 渲染层的 ctx.stage 只给声明了 stage 的插件;这里按装着的那份 manifest 再核一次(插件能绕开 ctx 直接调通道)
    if (!self.capabilities.includes('stage')) return fail('unsupported', 'this plugin does not declare the "stage" capability in manifest.json')
    const wanted = [...opts.plugins, ...(opts.includeSelf && !opts.plugins.includes(self.id) ? [self.folder] : [])]
    const found: InstalledPlugin[] = []
    for (const ref of wanted) {
      const p = await findInstalledPlugin(home, ref)
      if (!p) return fail('plugin-missing', `plugin "${ref}" is not installed in this Forsion`)
      if (!found.some((x) => x.dir === p.dir)) found.push(p)
    }
    const fixture = opts.fixture ? await resolveFixture(self.dir, opts.fixture).catch((e) => e as StageError) : null
    if (fixture instanceof StageError) return fail(fixture.code, fixture.message)
    // stages 本身不能是软链(Codex 11-20):同意记录、建目录都会写穿到链的那头;先核再碰任何东西
    if (!(await stagesBaseOk(home))) return fail('error', `${join(home, 'stages')} is a link or not a folder; remove it and try again`)
    if (!(await grants().has(self.id))) {
      const yes = await deps.confirm({ pluginId: self.id, name: self.name }, found.map((p) => p.name), opts)
      if (!yes) return fail('denied', 'the user did not allow this plugin to open a stage')
      await grants().add(self.id).catch((e) => deps.log(`[plugin-stage] could not remember the grant: ${e instanceof Error ? e.message : String(e)}`))
    }
    // 先把前一份舞台(哪怕是自己的)停干净:它的退出事件会清主人、关回放服务,得赶在新的那份立起来之前
    if (deps.sandbox.state().running) await deps.sandbox.stop()
    owner = null
    await dropEngine()
    // 脚本回放:先起好服务,舞台的引擎地址才填得进去
    let backendUrl: string | undefined
    let backendToken: string | undefined
    if (opts.engine === 'scripted') {
      const file = join(fixture!, 'engine.json')
      const fst = await lstat(file).catch(() => null)
      if (!fst?.isFile() || fst.size > ENGINE_SCRIPT_MAX) return fail('fixture-invalid', `engine "scripted" needs ${opts.fixture}/engine.json (a regular file up to 2 MB)`)
      let script: unknown
      try { script = JSON.parse(await readFile(file, 'utf8')) } catch (e) { return fail('fixture-invalid', `engine.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
      // 个人日历:fixture 里 human/CALENDAR.db(和真引擎家目录里那份同一个位置)。有就交给回放服务按真引擎的报文回;没有 = 空日历
      let calendar: string | undefined
      try { calendar = await readFixtureCalendar(fixture!) } catch (e) { return fail('fixture-invalid', `${opts.fixture}/${e instanceof Error ? e.message : String(e)}`) }
      try {
        const e = await deps.startEngine(script, calendar === undefined ? undefined : { calendar })
        engine = e
        backendUrl = e.url
        backendToken = e.token
      } catch (e) {
        return fail(e instanceof StageError ? e.code : 'fixture-invalid', e instanceof Error ? e.message : String(e))
      }
    }
    const info: StageChildInfo = { plugins: found.map((p) => p.id), window: opts.window, ...(opts.clock ? { clock: opts.clock } : {}), engine: opts.engine }
    owner = ownerId
    gen += 1 // 开始换就作废旧代号:起新舞台的这几秒里,旧句柄的动作不会落到新的那份上(Codex 11-20)
    const r = await deps.sandbox.openStage({ pluginId: self.id, name: self.name, version: self.version }, {
      info: info as unknown as Record<string, unknown>,
      ui: { locale: opts.locale, storage: stageThemeStorage(opts.theme) },
      args: [],
      ...(backendUrl ? { backendUrl } : {}),
      ...(backendToken ? { backendToken } : {}),
      prepare: async (paths) => {
        if (fixture) {
          const vault = join(fixture, 'vault')
          const vst = await lstat(vault).catch(() => null)
          if (vst?.isSymbolicLink()) throw new StageError('fixture-invalid', `${opts.fixture}/vault is a link; ship the demo vault as a real folder in the plugin`)
          if (vst?.isDirectory()) await copyTreePlain(vault, paths.vault)
        }
        for (const p of found) await copyPluginPackage(p, join(paths.home, 'plugins'))
      },
    })
    if (!r.ok) { owner = null; await dropEngine(); return fail(r.code === 'no_sandbox' ? 'closed' : 'error', r.error || 'the stage did not start') }
    let status: { state?: string; setupError?: string | null } = {}
    try { status = JSON.parse(r.text || '{}') } catch { /* 状态坏了按没起来 */ }
    if (status.state === 'starting') { await close(ownerId); return fail('timeout', 'the stage did not finish loading in time') }
    if (status.state === 'failed' || status.state === 'blocked') { await close(ownerId); return fail('plugin-missing', status.setupError || 'a plugin did not load in the stage') }
    return { ok: true, gen, window: opts.window, plugins: info.plugins, engine: opts.engine }
  }

  async function close(ownerId: string, want?: number): Promise<StageReply> {
    if (owner !== ownerId || (want !== undefined && want !== gen)) return { ok: true }
    owner = null
    await deps.sandbox.stop()
    await dropEngine()
    return { ok: true }
  }

  /** 插件那头的一次调用:先认主人(只有起舞台的那个插件能动它),再分派。 */
  async function exec(ownerId: string, op: string, args: Record<string, unknown>, locale: 'zh' | 'en'): Promise<StageReply> {
    try {
      if (!isStagePluginRef(ownerId)) return fail('invalid', 'bad plugin id')
      if (op === 'open') return await serial(() => open(ownerId, args, locale))
      const want = typeof args.__gen === 'number' ? args.__gen : undefined
      if (op === 'close') return await serial(() => close(ownerId, want))
      const st = deps.sandbox.state()
      if (owner !== ownerId || !st.running || (want !== undefined && want !== gen)) return fail('closed', 'the stage is not open (it may have stopped after being idle, or was opened again)')
      switch (op) {
        case 'space': return actionOf(await deps.sandbox.exec('space', { space: String(args.space ?? '') }))
        case 'command': return actionOf(await deps.sandbox.exec('command', { command: String(args.command ?? ''), args: args.args ?? {} }))
        case 'click': case 'read': case 'scroll':
          return actionOf(await deps.sandbox.exec(op, { target: typeof args.target === 'string' ? args.target : '', ...(op === 'scroll' && typeof args.amount === 'number' ? { amount: args.amount } : {}) }))
        case 'type': return actionOf(await deps.sandbox.exec('type', { text: String(args.text ?? ''), ...(typeof args.target === 'string' ? { target: args.target } : {}), ...(args.append === true ? { append: true } : {}) }))
        case 'press': return actionOf(await deps.sandbox.exec('press', { key: String(args.key ?? ''), ...(typeof args.target === 'string' ? { target: args.target } : {}) }))
        case 'capture': {
          const rect = args.rect == null ? undefined : sanitizeStageRect(args.rect)
          if (args.rect != null && !rect) return fail('invalid', 'rect must be { x, y, width, height } in CSS pixels')
          const selector = typeof args.selector === 'string' ? args.selector.slice(0, 300) : undefined
          const r = await deps.sandbox.raw('capture', { ...(rect ? { rect } : {}), ...(selector ? { selector } : {}) }, 30_000)
          if (typeof r.error === 'string') return fail('error', r.error)
          return { ok: true, bytes: await takeOutput(ownerId, r.path), width: r.width, height: r.height, mime: 'image/png' }
        }
        case 'recordStart': {
          const r = await deps.sandbox.raw('recordStart', sanitizeStageRecord(args), 20_000)
          return typeof r.error === 'string' ? fail('error', r.error) : { ok: true, mime: r.mime }
        }
        case 'recordPause': case 'recordResume': {
          const r = await deps.sandbox.raw(op, {}, 15_000)
          return typeof r.error === 'string' ? fail('error', r.error) : { ok: true }
        }
        case 'recordStop': {
          const r = await deps.sandbox.raw('recordStop', {}, 90_000)
          if (typeof r.error === 'string') return fail('error', r.error)
          return { ok: true, bytes: await takeOutput(ownerId, r.path), mime: r.mime, width: r.width, height: r.height, durationMs: r.durationMs }
        }
        default: return fail('invalid', `unknown stage action "${op}"`)
      }
    } catch (e) {
      const code: StageErrorCode = e instanceof StageError ? e.code : /did not answer .* in time/.test(String((e as Error)?.message)) ? 'timeout' : 'error'
      return fail(code, e instanceof Error ? e.message : String(e))
    }
  }

  return {
    exec,
    /** 插件停用 / 重载 / 卸载:宿主替它关。 */
    closeFor: (ownerId: string) => serial(() => close(ownerId)),
    /** 舞台进程自己没了(闲置自停 / 崩了):主人清掉、回放服务关掉。 */
    onState: (running: boolean): void => { if (!running && owner) { owner = null; void dropEngine() } },
    owner: () => owner,
    dispose: async () => { owner = null; await deps.sandbox.stop(); await dropEngine() },
  }
}

export type PluginStage = ReturnType<typeof createPluginStage>
