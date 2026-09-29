/** 反链面板(右栏 tab;评审 2026-09-27 L-16):
 *  - 已链接:按来源笔记分组,**逐处**列出上下文(索引给的 hits,摘录已去 md 语法;属性区的链接标「属性」)。
 *    旧宿主(云端 / Unit 旧版)没有 hits → 退回单条 snippet。
 *  - 未链接提及:提到本页标题 / 别名却没加 [[ ]] 的地方,默认折叠;**展开才去取**(全库扫描,不跟每次保存跑),
 *    展开期间随链接图版本刷新。每处带「链接」按钮 → amadeus.linkMention 按内容定位改写(对不上不写)。
 *    宿主没有这两条可选接口时整区不出现 / 不出按钮。 */
import { useEffect, useState } from 'react'
import { usePageStore } from '@amadeus/store/pageStore'
import { amadeus } from '@amadeus/api'
import { pageKey } from '@amadeus-shared/links'
import type { BacklinkRef, MentionHit, UnlinkedMention } from '@amadeus-shared/ipc'
import { openNote } from './amadeusNav'
import { registerMessages, useI18n, translate } from './i18n'

registerMessages({
  'amxbl.prop': { zh: '属性', en: 'Property' },
  'amxbl.unlinked': { zh: '未链接提及', en: 'Unlinked mentions' },
  'amxbl.unlinkedCount': { zh: '未链接提及 · {n}', en: 'Unlinked mentions · {n}' },
  'amxbl.unlinkedEmpty': { zh: '没有未链接的提及。', en: 'No unlinked mentions.' },
  'amxbl.link': { zh: '链接', en: 'Link' },
  'amxbl.linkTip': { zh: '改写成 [[{inner}]]', en: 'Turn into [[{inner}]]' },
  'amxbl.linkFailed': { zh: '这处提及在列出之后已被改动，没有改写。', en: 'That mention changed after it was listed, so nothing was rewritten.' },
})

const baseName = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')

/** 一键链接的 [[ ]] 内文:目标名按「唯一即最短」(同 WikiSuggest.linkInner),提及原文与名字不同(大小写 / 别名)时带 `|原文`。 */
export function mentionInner(targetPath: string, pages: string[], match: string): string {
  const title = baseName(targetPath)
  const unique = pages.filter((p) => pageKey(p) === pageKey(targetPath)).length <= 1
  const name = unique ? title : targetPath.replace(/\\/g, '/').replace(/\.md$/i, '')
  return match === title && unique ? title : `${name}|${match}`
}

function MentionText({ h }: { h: MentionHit }) {
  if (!h.match) return <>{h.text}</>
  const i = h.text.toLowerCase().indexOf(h.match.toLowerCase())
  if (i < 0) return <>{h.text}</>
  return (
    <>
      {h.text.slice(0, i)}
      <mark>{h.text.slice(i, i + h.match.length)}</mark>
      {h.text.slice(i + h.match.length)}
    </>
  )
}

export function AmadeusBacklinksView() {
  const { t } = useI18n()
  // v4 笔记不设 activePage → 回落到 activeNotePath,否则本视图对 v4 恒显示「未打开笔记」。
  const activePage = usePageStore((s) => s.activePage ?? s.activeNotePath)
  const version = usePageStore((s) => s.linkGraphVersion)
  const pages = usePageStore((s) => s.pages)
  const [refs, setRefs] = useState<BacklinkRef[]>([])
  const [showUnlinked, setShowUnlinked] = useState(false)
  const [unlinked, setUnlinked] = useState<UnlinkedMention[] | null>(null)
  const [tick, setTick] = useState(0) // 一键链接成功后本地重取(不赌 externalChange 一定带动 linkGraphVersion)
  useEffect(() => {
    let live = true
    if (!activePage) { setRefs([]); return }
    void amadeus.backlinks(activePage).then((r) => { if (live) setRefs(r) })
    return () => { live = false }
  }, [activePage, version, tick])
  useEffect(() => {
    let live = true
    if (!activePage || !showUnlinked || !amadeus.unlinkedMentions) { setUnlinked(null); return }
    void amadeus.unlinkedMentions(activePage).then((r) => { if (live) setUnlinked(r) }).catch(() => { if (live) setUnlinked([]) })
    return () => { live = false }
  }, [activePage, showUnlinked, version, tick])

  const link = async (src: string, h: MentionHit): Promise<void> => {
    if (!activePage || !amadeus.linkMention || h.raw === undefined || h.occ === undefined || h.col === undefined || !h.match) return
    const inner = mentionInner(activePage, pages, h.match)
    const ok = await amadeus.linkMention(src, { raw: h.raw, occ: h.occ, col: h.col, match: h.match }, inner).catch(() => false)
    if (!ok) window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('amxbl.linkFailed') } }))
    setTick((n) => n + 1)
  }

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">{t('amadeus.backlinks')} · {refs.length}</div>
      {!activePage ? (
        <div className="amx-panel-empty">{t('amxv.backlinks.noNote')}</div>
      ) : (
        <>
          {refs.length === 0 ? (
            <div className="amx-panel-empty">{t('amxv.backlinks.empty')}</div>
          ) : (
            <div className="amx-list">
              {refs.map((r) => (
                <div key={r.path} className="amx-backlink-group">
                  <button className="amx-list-item amx-backlink-src" onClick={() => void openNote(r.path)} title={r.path}>
                    {r.title}
                  </button>
                  {(r.hits ?? (r.snippet ? [{ line: 1, text: r.snippet }] : [])).map((h, i) => (
                    <button key={`${h.line}:${i}`} className="amx-list-item amx-backlink-hit" onClick={() => void openNote(r.path)}>
                      {h.line === 0 && <span className="amx-backlink-prop">{t('amxbl.prop')}</span>}
                      {h.text}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {amadeus.unlinkedMentions && (
            <>
              <button className="amx-panel-head amx-backlink-toggle" aria-expanded={showUnlinked} onClick={() => setShowUnlinked((v) => !v)}>
                {showUnlinked ? '▾ ' : '▸ '}
                {unlinked && showUnlinked ? t('amxbl.unlinkedCount', { n: unlinked.length }) : t('amxbl.unlinked')}
              </button>
              {showUnlinked && unlinked && (unlinked.length === 0 ? (
                <div className="amx-panel-empty">{t('amxbl.unlinkedEmpty')}</div>
              ) : (
                <div className="amx-list">
                  {unlinked.map((m) => (
                    <div key={m.path} className="amx-backlink-group">
                      <button className="amx-list-item amx-backlink-src" onClick={() => void openNote(m.path)} title={m.path}>
                        {m.title}
                      </button>
                      {m.hits.map((h, i) => (
                        <div key={`${h.line}:${i}`} className="amx-backlink-hit amx-mention">
                          <button className="amx-list-item amx-mention-text" onClick={() => void openNote(m.path)}>
                            <MentionText h={h} />
                          </button>
                          {amadeus.linkMention && h.col !== undefined && h.match && (
                            <button
                              className="amx-backlink-link"
                              title={t('amxbl.linkTip', { inner: mentionInner(activePage, pages, h.match) })}
                              onClick={() => void link(m.path, h)}
                            >
                              {t('amxbl.link')}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
