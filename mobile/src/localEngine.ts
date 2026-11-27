/**
 * 「这台手机」本机引擎的 JS 半身(第 1 期):把原生 ForsionLocalEngine 插件装成 `window.tangu.localEngine`,
 * 状态进 usePhoneEngine(desktop services/engine/phoneEngine.ts),并在两处替原生把引擎拉起来:
 *   - 焦点落到这台手机:testConnection 先 start()(见 agentRunService),这里只管失败 → 回云端;
 *   - 打开一条绑在这台手机上的会话而引擎没在跑:先 start(),再重拉那条会话的历史。
 * 原生只为写请求和显式 start 拉起引擎(GET 轮询不拉,免得「停止」之后被轮询悄悄拉回来)。
 *
 * 端口与本机令牌只在原生侧;请求照旧经原生 UnitRelay(保留 id 改发 127.0.0.1)。
 * 用户可见文案(通知渠道、通知正文、「停止」)经 configure() 推给原生,切语言重推。
 * 只装在安卓 App、且原生插件在(老包 / 网页手机形态缺席 → 「这台手机」整个不出现)。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { registerMessages, subscribeLocale, translate } from '@/i18n'
import {
  isPhoneRef, setPhoneEngineState, usePhoneEngine,
  type PhoneEngineHost, type PhoneEngineState, type PhoneEngineUsage,
} from '@/services/engine/phoneEngine'
import { focusRef, refForSession } from '@/services/engine/targets'
import { HOME_REF } from '@/services/engine/target'
import { useApp } from '@/stores/appStore'
import { setDraftLocation } from '@/stores/runLocationStore'
import { useDeviceSessions } from '@/stores/deviceSessionsStore'

interface LocalEnginePlugin {
  state(): Promise<PhoneEngineState>
  check(): Promise<PhoneEngineState>
  install(o: { reset?: boolean }): Promise<PhoneEngineState>
  update(): Promise<PhoneEngineState>
  pause(): Promise<PhoneEngineState>
  remove(): Promise<unknown>
  start(): Promise<PhoneEngineState>
  stop(): Promise<PhoneEngineState>
  usage(): Promise<PhoneEngineUsage>
  metered(): Promise<{ metered: boolean }>
  configure(o: { strings: Record<string, string> }): Promise<unknown>
  addListener(ev: 'state', cb: (s: PhoneEngineState) => void): Promise<PluginListenerHandle>
}

registerMessages({
  // 前台服务通知(原生用;键名 = LocalEnginePlugin.configure 的 strings 键)
  'phoneEngine.native.channel': { zh: '本机环境', en: 'Local environment' },
  'phoneEngine.native.title': { zh: 'Forsion 本机环境正在运行', en: 'Forsion local environment is running' },
  'phoneEngine.native.text': { zh: 'Agent 在这台手机上运行，没有任务 10 分钟后自动停止', en: 'The agent runs on this phone and stops after 10 minutes without tasks' },
  'phoneEngine.native.stop': { zh: '停止', en: 'Stop' },
  'phoneEngine.backToCloud': { zh: '本机环境没能启动，新对话仍在 Forsion 云端运行', en: "The local environment couldn't start. New chats still run in Forsion cloud" },
})

const NATIVE_KEYS = ['channel', 'title', 'text', 'stop'] as const

let installed = false

export function installLocalEngine(): void {
  if (installed) return
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ForsionLocalEngine')) return
  const tangu = window.tangu
  if (!tangu) return
  installed = true
  const Native = registerPlugin<LocalEnginePlugin>('ForsionLocalEngine')

  const apply = (s: PhoneEngineState | null | undefined): PhoneEngineState => {
    const next = s && typeof s === 'object' ? s : {}
    setPhoneEngineState(next)
    return next
  }
  const listeners = new Set<(s: PhoneEngineState) => void>()
  // 并发的 start() 合成一次(testConnection、打开会话、行上的按钮可能同时要)
  let starting: Promise<PhoneEngineState> | null = null

  const host: PhoneEngineHost = {
    state: () => Native.state().then(apply),
    check: () => Native.check().then(apply),
    install: (o) => Native.install({ reset: !!o?.reset }).then(apply),
    update: () => Native.update().then(apply),
    pause: () => Native.pause().then(apply),
    remove: () => Native.remove().then((r) => { void Native.state().then(apply).catch(() => {}); return r }),
    start: () => {
      if (!starting) starting = Native.start().then(apply).finally(() => { starting = null })
      return starting
    },
    stop: () => Native.stop().then(apply),
    usage: () => Native.usage(),
    metered: () => Native.metered(),
    configure: (strings) => Native.configure({ strings }),
    onState: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  tangu.localEngine = host

  void Native.addListener('state', (s) => {
    const prev = usePhoneEngine.getState().state
    const next = apply(s)
    for (const cb of [...listeners]) { try { cb(next) } catch { /* 订阅者自己的错 */ } }
    onTransition(prev, next)
  }).catch((e) => console.warn('[local-engine] state listener rejected:', e))
  void Native.state().then(apply).catch((e) => {
    // 读不到 ≠ 没有:留 null(「这台手机」暂不出现),不当成「没装」往下判
    console.warn('[local-engine] state() rejected:', e)
  })

  const pushStrings = (): void => {
    const strings: Record<string, string> = {}
    for (const k of NATIVE_KEYS) strings[k] = translate(`phoneEngine.native.${k}`)
    void Native.configure({ strings }).catch((e) => console.warn('[local-engine] configure rejected:', e))
  }
  pushStrings()
  subscribeLocale(pushStrings)

  // 打开一条在这台手机上的会话:引擎没在跑就先拉起来,再重拉历史(打开时那次 GET 被原生拒了)
  let lastActive = useApp.getState().activeId
  useApp.subscribe((st) => {
    if (st.activeId === lastActive) return
    lastActive = st.activeId
    const sid = st.activeId
    if (!sid || !isPhoneRef(refForSession(sid))) return
    if (usePhoneEngine.getState().state?.engine === 'running') return
    void host.start().then(() => {
      if (useApp.getState().activeId === sid) void useApp.getState().loadSessionHistory(sid)
    }, () => useApp.getState().toast(translate('phoneEngine.startFailed'), true))
  })
}

/** 状态跳变的副作用:起不来 / 环境没了而焦点还在这台手机 → 回云端并说一声;刚跑起来 → 刷新侧栏里这台手机的会话。 */
function onTransition(prev: PhoneEngineState | null, next: PhoneEngineState): void {
  const focusOnPhone = isPhoneRef(focusRef())
  if (focusOnPhone && ((next.engine === 'failed' && prev?.engine !== 'failed') || (prev?.installed && !next.installed))) {
    // 记成云端(亲手选过的那份改掉):不然每开一份新草稿都会再试一次、再失败一次
    void setDraftLocation(HOME_REF, { explicit: true }).catch(() => {})
    useApp.getState().toast(translate('phoneEngine.backToCloud'), true)
  }
  if (next.engine === 'running' && prev?.engine !== 'running') void useDeviceSessions.getState().refresh({ force: true }).catch(() => {})
}
