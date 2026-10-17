// 不引 store:AgentHarnessPanel 也在设置弹窗里用,拉进 appStore 会连带 pluginStore 的模块级副作用(mock 了 i18n 的测试直接挂)

/** 一次性落到某几条记录的令牌(对话里的留痕 / 更新卡点「查看」):at 变了才跳。texts = 那几条的原文(活动流里整串截过 300 字,按包含比);
 *  项目 → 「设置 › 项目记忆」,part: 'compacted' 落在「被合并的原句」;Agent → 「成长 › 进化」。一条都对不上就落在整块。 */
export interface RecordJump { at: number; texts: string[]; part?: 'compacted' }

let revealedAt = 0
/** 这枚令牌还没落过(at 是 Date.now(),单调):切走再切回、视图重挂,都不重放上一次的落点。 */
export const freshJump = (jump?: RecordJump): jump is RecordJump => !!jump && jump.at > revealedAt

/** 详情页里落到 rows 中文字对得上 texts 的那几行:滚到第一行、短暂高亮;一行都对不上就滚到 fallback(整块只滚不亮)。调用即用掉令牌。
 *  滚动放到下一帧:同一次提交里父组件切标签时会把滚动条归零(AgentProfile 的 navigate),先滚就白滚了。
 *  不用 scrollIntoView:它会连带滚动 overflow:hidden 的祖先(右栏整体错位),只滚最近的可滚动容器。 */
export function revealRecords(jump: RecordJump, rows: Iterable<HTMLElement>, fallback: HTMLElement | null): void {
  revealedAt = Math.max(revealedAt, jump.at)
  const norm = (x: string): string => x.replace(/\s+/g, ' ').trim()
  // 引擎把几条按 ' | ' 拼起来整串截 300 字(localHistorian 的 logActivity):到了截断线,末条可能只剩开头几个字,太短就不拿来比,免得亮一片
  const capped = jump.texts.join(' | ').length >= 290
  const want = jump.texts.map(norm).filter((x, i, all) => x && !(capped && i === all.length - 1 && x.length < 8))
  const hit = want.length ? [...rows].filter((el) => want.some((w) => norm(el.textContent || '').includes(w))) : []
  const target = hit[0] || fallback
  if (!target) return
  requestAnimationFrame(() => {
    if (!target.isConnected) return
    let sc = target.parentElement
    while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement
    if (sc) {
      const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - Math.max(16, (sc.clientHeight - target.offsetHeight) / 2)
      sc.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    for (const el of hit) {
      el.removeAttribute('data-record-flash'); void el.offsetWidth // 连点两次「查看」也要重新亮一遍
      el.setAttribute('data-record-flash', '')
      setTimeout(() => el.removeAttribute('data-record-flash'), 1800)
    }
  })
}
