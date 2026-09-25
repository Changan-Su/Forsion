/** History 面板的纯逻辑:形态判定、自动版本命名、相对时间。抽出来是为了能单测 ——
 *  这三件事都只吃数据不碰 DOM,混在组件里就只能靠 e2e 兜,代价差一个数量级。 */
import type { GitPanelStatus } from '../../../../shared/products'
import type { UiMessage } from '../../types'
import { translate } from '../../i18n'
import { normPath } from './studioModel'
import './studioMessages'

/** 面板四态。unsupported = 宿主压根没有 git 桥(老版本 / web / mobile),整块不渲染,只留旧快照。 */
export type HistoryModeKind = 'unsupported' | 'install' | 'writable' | 'readonly'

export interface HistoryMode {
  mode: HistoryModeKind
  /** 需要向用户解释时的文案键;无需解释(已建仓的可写项目)为空串。 */
  reasonKey: string
}

/** 宿主的 git 判定 → 面板形态。只读的三种理由必须分开说清楚,否则用户只看到「不能保存」。 */
export function historyMode(status: GitPanelStatus | null | undefined): HistoryMode {
  if (!status) return { mode: 'unsupported', reasonKey: '' }
  if (!status.available) return { mode: 'install', reasonKey: 'studio.history.gitWhy' }
  // 尚未建仓的可写项目要提前告知「保存会在项目里创建 .git」——事后才发现多出个目录会吓到人。
  if (status.writable) return { mode: 'writable', reasonKey: status.state === 'none' ? 'studio.history.firstVersionNote' : '' }
  return {
    mode: 'readonly',
    reasonKey: status.state === 'foreign' ? 'studio.history.readonlyForeign'
      : status.state === 'nested' ? 'studio.history.readonlyNested'
        : 'studio.history.readonlyOutside',
  }
}

/**
 * 「这一轮 agent 刚跑完」= running 只在 true→false 这一沿上为真。
 * 抽成纯函数是因为这个判断**错了不会红**:挂载时补一次就多出一个空版本,沿判反了就一个版本都不存,
 * 既不报类型错也不崩,只能靠单测钉。调用点把上一次的值存在 ref 里,每次 effect 各求一次值。
 */
export function runEnded(previous: boolean, next: boolean): boolean {
  return previous && !next
}

/**
 * 异步回来之后「还是不是同一个项目」。自动提交是背景动作,await 期间用户完全可能已经切走,
 * 这时再去刷面板 / 记状态就是把上一个项目的结果记到新项目头上。
 * 按 normPath 比,和 ProjectStudio 里算 running 用的是同一套归一(尾斜杠 / 反斜杠都不该算两个项目)。
 */
export function sameProject(root: string, active: string | null | undefined): boolean {
  return !!root && !!active && normPath(root) === normPath(active)
}

/** 版本名上限(字素粗略按码点算);超出留一位给省略号。 */
const NAME_MAX = 72

/**
 * 自动版本的名字 = 本会话**最后一条用户消息**的首个非空行。
 * 故意不往前翻找:空的最后一条(纯附件 / 纯图片)应当落到通用名,而不是顶着上一轮的标题存版本。
 */
export function autoVersionName(messages: UiMessage[]): string {
  let last: UiMessage | undefined
  for (const message of messages) if (message?.role === 'user') last = message
  const line = String(last?.content ?? '').split('\n').map(text => text.replace(/\s+/g, ' ').trim()).find(Boolean)
  if (!line) return translate('studio.history.autoFallback')
  // 按码点切:`slice` 会把 emoji / 代理对拦腰截断,落盘成半个字符。
  const points = [...line]
  return points.length > NAME_MAX ? `${points.slice(0, NAME_MAX - 1).join('')}…` : line
}

