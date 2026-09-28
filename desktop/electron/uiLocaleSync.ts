/**
 * 主进程文案语言的**唯一**喂入口(P1-KF,修 K5 的接线):渲染层报来的**生效**界面语言。
 *
 * 为什么不再读 localStorage `tangu_locale`(K5 原接线:主窗 did-finish-load 读一次 + ui:sync 的 prefs 转进来):
 *   那个键只在「① 用户手选」时写(③ IP 校正真改了语言时顺带写)。渲染层按 ② 系统语言(Electron 的 navigator 语言,
 *   与 app.getPreferredSystemLanguages() 并不总一致 —— `--lang=zh-CN` 的台架就是一例)或 ③ 已缓存的 IP 区域判出中文时,
 *   键是空的 → 主进程回落自己的系统判定 → 中文界面下弹英文的远程审批通知(P1-K3 修复报告实测)。更糟的是任何字体 / 缩放
 *   变更的 ui:sync 都带着 `tangu_locale: null`,把已经对上的语言又重置回系统。
 * 现在:渲染层(i18n.tsx 的 LocaleProvider 挂载 + 每次切换)把四级链判完的结论经 `ui:locale` 报上来,这里设成主进程覆盖值;
 * 渲染层的判定只有一份,主进程不另写(CLAUDE.md「界面语言自适应」)。
 *
 * 窗口载入之前(托盘刚建、启动期就到的远程审批通知):用上次报来的值(userData/ui-locale.json),没有才回落系统语言 ——
 * 首次运行之外,主进程从第一句文案起就与界面同语言。文件只是缓存:坏了 / 读不出 = 当没有,绝不抛。
 */
import { readFileSync } from 'node:fs'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { setMainLocale, type MainLocale } from './mainI18n'
import { normalizeUiLocale } from '../shared/uiSync'

export const UI_LOCALE_FILE = 'ui-locale.json'

export interface UiLocaleSyncDeps {
  /** userData/ui-locale.json 的路径(惰性求值:userData 在 main.ts 顶部才改成 -dev)。 */
  file(): string
  /** 同步读(启动早期、窗口还没建);缺省 fs.readFileSync。 */
  readFileSync?(file: string): string
  /** 原子落盘;缺省 writePrivateJson(临时名 + rename)。 */
  writeFile?(file: string, data: unknown): Promise<void>
  log?(m: string): void
}

export interface UiLocaleSync {
  /** 启动(whenReady,initMainLocale 之后、托盘 / 窗口之前):上次的界面语言 → 主进程覆盖值。回读到的值;没有 = null(跟随系统)。 */
  seed(): MainLocale | null
  /** 渲染层报来的生效语言(IPC 已验发送方)。非 zh/en 丢弃;与上次落盘的不同才写盘。 */
  report(v: unknown): void
  /** 等在途的落盘写完(测试用)。 */
  flush(): Promise<void>
}

export function createUiLocaleSync(deps: UiLocaleSyncDeps): UiLocaleSync {
  const read = deps.readFileSync ?? ((f: string) => readFileSync(f, 'utf8'))
  const write = deps.writeFile ?? writePrivateJson
  const log = deps.log ?? (() => {})
  const queue = createSerialQueue()
  let persisted: MainLocale | null = null
  let tail: Promise<void> = Promise.resolve()

  return {
    seed() {
      let v: MainLocale | null = null
      try {
        v = normalizeUiLocale((JSON.parse(read(deps.file())) as { locale?: unknown } | null)?.locale)
      } catch { /* 没有 / 坏了 = 首次运行,跟随系统 */ }
      persisted = v
      if (v) setMainLocale(v)
      return v
    },
    report(raw) {
      const v = normalizeUiLocale(raw)
      if (!v) return
      setMainLocale(v)
      if (v === persisted) return
      persisted = v
      tail = queue(() => write(deps.file(), { v: 1, locale: v })).catch((e) => {
        persisted = null // 下一次报上来时重试
        log(`[ui-locale] 界面语言缓存落盘失败(下次启动前的文案回落系统语言):${(e as Error)?.message || e}`)
      })
    },
    flush: () => tail,
  }
}
