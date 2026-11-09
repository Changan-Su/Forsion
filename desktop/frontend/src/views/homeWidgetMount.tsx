/**
 * 主页宿主件画进接管主页的插件给的元素(`ctx.home.mount` / `mountPart`,主页插件化 B 的 H1,2026-11-09)。
 * 卡头 / 卡芯 / 图标和内置主页是同一套组件(homeWidgetKinds):卡里的内容归宿主,插件只管格子、拖动、编辑态那几颗按钮。
 * 「卜算子·建议没内容时这一格改画最近对话」也在这里算(useShownWidgetId),插件不用知道。
 * 由 amadeus/plugins/pluginHome.tsx 动态 import(同 homeCardStatus:没人挂卡就不拉这些模块)。
 */
import { mountHostReact } from '@lcl/components'
import { HostLocaleProvider } from '../i18n'
import { HomeWidgetBody, HomeWidgetEnv, useHomeWidgetHead, useShownWidgetId } from './homeWidgetKinds'
import { isOnHome, useHomeLayout } from './homeWidgets'
import { ComputerHistoryAsk } from '../components/ComputerHistoryAsk'
import './homepage.css'

export type HomeWidgetPart = 'head' | 'body' | 'icon'
export interface HomeWidgetMountOpts {
  part: HomeWidgetPart
  wide: boolean
  /** 只给 'icon':图标边长。 */
  size: number
  /** 编辑态里卡头标题不当「打开所在 Space」的按钮(按下去是拖动)。 */
  editing: boolean
  onRemove: () => void
  onComposer: () => void
}

function Part({ id, o }: { id: string; o: HomeWidgetMountOpts }): React.JSX.Element {
  const layout = useHomeLayout()
  const shown = useShownWidgetId(id, (x) => isOnHome(layout, x))
  const head = useHomeWidgetHead(shown, o.part === 'icon' ? o.size : 13)
  if (o.part === 'icon') return <>{head.icon}</>
  if (o.part === 'head') {
    return (
      <>
        {head.icon}
        {head.open && !o.editing
          ? <button type="button" className="hp-wcard-title hp-wcard-go" onClick={head.open}>{head.title}</button>
          : <span className="hp-wcard-title">{head.title}</span>}
        {head.owner && <span className="hp-wcard-owner">{head.owner}</span>}
      </>
    )
  }
  return (
    <HomeWidgetEnv.Provider value={{ openComposer: o.onComposer }}>
      <HomeWidgetBody id={shown} wide={o.wide} onRemove={o.onRemove} />
    </HomeWidgetEnv.Provider>
  )
}

/** 同一个 el 上挂第二份会顶掉第一份(mountHostReact 的规矩)。`update` 换选项不重挂:卡里的状态(展开、滚动)留着。 */
export function mountHomeWidget(el: HTMLElement, id: string, o: HomeWidgetMountOpts): { update(next: HomeWidgetMountOpts): void; dispose(): void } {
  const node = (opts: HomeWidgetMountOpts): React.JSX.Element => <HostLocaleProvider><Part id={id} o={opts} /></HostLocaleProvider>
  const m = mountHostReact(el, node(o))
  return { update: (next) => m.render(node(next)), dispose: m.dispose }
}

/** 宿主自己的小件。名字表只许加不许改(插件按名字要)。 */
const HOST_PARTS = new Map<string, () => React.ReactNode>([
  // 首启跳过「电脑历史」后主页再问一次那张卡(引导第四轮 A4);这台机器不需要问时它自己什么都不画
  ['computer-history-ask', () => <ComputerHistoryAsk />],
])
export const HOME_HOST_PARTS: readonly string[] = [...HOST_PARTS.keys()]

export function mountHomePart(el: HTMLElement, name: string): { dispose(): void } | null {
  const render = HOST_PARTS.get(name) // Map:'__proto__' / 'toString' 之类的名字查不到东西
  if (!render) return null
  return mountHostReact(el, <HostLocaleProvider>{render()}</HostLocaleProvider>)
}
