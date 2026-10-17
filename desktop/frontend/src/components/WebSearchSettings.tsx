// 设置 → 模型 → 联网搜索(本机 engine /agent/websearch,写 config.json webSearch 段,搜索时即时生效)。
// 与后台「联网搜索」页同一套语义:「使用中」从上往下试,写 order + provider:'auto'(解掉 Tangu 用 appSettings 钉的首位);
// 「未启用」= 已连接但停用 / 未连接。排序、启停、连接、断开、档位都即时写,没有「保存」;改顺序后 5 秒内可撤销。
// 每次写都带上屏上的完整 order:配置里 order 为 null(没排过)时也不会因为解钉而换序。
import React, { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, GripVertical, Info, KeyRound, Loader2, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { saveLocalWebSearch, testLocalWebSearch, type LocalWebSearchRedacted, type LocalWebSearchSave, type WebSearchProvider } from '../services/backendService'
import type { EngineTarget } from '../services/engine/target'
import './WebSearchSettings.css'

registerMessages({
  'websearch.inUse': { zh: '使用中', en: 'In use' },
  'websearch.off': { zh: '未启用', en: 'Not in use' },
  'websearch.intro': { zh: 'web_search 从上往下试，前一个出错就换下一个。拖动或用 ↑↓ 调整，松手立即生效。', en: 'web_search tries these from the top and moves on when one fails. Drag or use ↑↓ to reorder; changes apply right away.' },
  'websearch.note': { zh: '英文等非中文查询时，Tavily、DuckDuckGo 会自动提到最前，其余照上面的顺序。一个 Key 都没连接时，登录后走 Forsion 云端搜索，未登录用 DuckDuckGo。', en: 'For queries that are not in Chinese, Tavily and DuckDuckGo move to the front automatically; the rest keep this order. With no key connected, signed-in users search through Forsion Cloud and everyone else uses DuckDuckGo.' },
  'websearch.none': { zh: '没有在用的搜索源，web_search 会直接报错。', en: 'No search service is in use, so web_search will fail.' },
  'websearch.name.bocha': { zh: '博查 Bocha', en: 'Bocha' },
  'websearch.name.tavily': { zh: 'Tavily', en: 'Tavily' },
  'websearch.name.zhipu': { zh: '智谱 Web Search', en: 'Zhipu web search' },
  'websearch.name.deepseek': { zh: 'DeepSeek Search', en: 'DeepSeek Search' },
  'websearch.name.duckduckgo': { zh: 'DuckDuckGo', en: 'DuckDuckGo' },
  'websearch.desc.bocha': { zh: '国内直连 · 中文结果好', en: 'Reachable from mainland China · strong Chinese results' },
  'websearch.desc.tavily': { zh: '海外 · 免费 1,000 次 / 月', en: 'Overseas · 1,000 free searches per month' },
  'websearch.desc.zhipu': { zh: '国内直连 · 按引擎档位计费', en: 'Reachable from mainland China · billed by engine tier' },
  'websearch.desc.deepseek': { zh: '国内直连 · ¥5 / 千次', en: 'Reachable from mainland China · ¥5 per 1,000 searches' },
  'websearch.desc.duckduckgo': { zh: '免费 · 不需要 Key · 大陆网络不可达', en: 'Free · no key needed · unreachable from mainland China' },
  'websearch.testAll': { zh: '全部测试', en: 'Test all' },
  'websearch.test': { zh: '测试', en: 'Test' },
  'websearch.testing': { zh: '测试中…', en: 'Testing…' },
  'websearch.untested': { zh: '未测试', en: 'Not tested' },
  'websearch.statOk': { zh: '{ms} ms · {n} 条', en: '{ms} ms · {n} results' },
  'websearch.moveUp': { zh: '上移', en: 'Move up' },
  'websearch.moveDown': { zh: '下移', en: 'Move down' },
  'websearch.expand': { zh: '展开', en: 'Expand' },
  'websearch.collapse': { zh: '收起', en: 'Collapse' },
  'websearch.orderSaved': { zh: '已保存新顺序', en: 'New order saved' },
  'websearch.undo': { zh: '撤销', en: 'Undo' },
  'websearch.key': { zh: 'API Key', en: 'API key' },
  'websearch.keySaved': { zh: '已保存', en: 'Saved' },
  'websearch.noKey': { zh: '不需要 Key', en: 'No key needed' },
  'websearch.replace': { zh: '更换', en: 'Replace' },
  'websearch.disconnect': { zh: '断开', en: 'Disconnect' },
  'websearch.disconnectConfirm': { zh: '断开 {name}？已保存的 Key 会被删除，{name} 立即停止参与搜索。', en: 'Disconnect {name}? Its saved key is deleted and it stops being used for search right away.' },
  'websearch.engine': { zh: '引擎档位', en: 'Engine tier' },
  'websearch.disable': { zh: '停用', en: 'Disable' },
  'websearch.disableHint': { zh: '保留 Key，只是不再参与搜索', en: 'Keeps the key; it just stops being used for search' },
  'websearch.enable': { zh: '启用', en: 'Enable' },
  'websearch.connect': { zh: '连接', en: 'Connect' },
  'websearch.connectTest': { zh: '连接并测试', en: 'Connect and test' },
  'websearch.saveKey': { zh: '测试并保存', en: 'Test and save' },
  'websearch.cancel': { zh: '取消', en: 'Cancel' },
  'websearch.keyPh': { zh: '粘贴 API Key', en: 'Paste the API key' },
  'websearch.keyEmpty': { zh: '先填 API Key', en: 'Enter an API key first' },
  'websearch.keyTestFail': { zh: '测试没通过：{err}', en: 'Test failed: {err}' },
  'websearch.saveAnyway': { zh: '仍然保存', en: 'Save anyway' },
  'websearch.saveFail': { zh: '保存失败：{msg}', en: 'Save failed: {msg}' },
})

const ALL: WebSearchProvider[] = ['bocha', 'tavily', 'zhipu', 'deepseek', 'duckduckgo']
const ENGINES = [['search_pro_quark', 'quark'], ['search_pro_sogou', 'sogou'], ['search_pro', 'pro'], ['search_std', 'std']] as const
type Keyed = Exclude<WebSearchProvider, 'duckduckgo'>

const without = (o: WebSearchProvider[], p: WebSearchProvider) => o.filter((x) => x !== p)
/** 新启用 / 新连接的排在 DuckDuckGo 前(DDG 是兜底,大陆不可达) */
export function insertBeforeDdg(o: WebSearchProvider[], p: WebSearchProvider): WebSearchProvider[] {
  const out = without(o, p), i = p === 'duckduckgo' ? -1 : out.indexOf('duckduckgo')
  if (i < 0) out.push(p); else out.splice(i, 0, p)
  return out
}

export function WebSearchSettings({ target, cfg, setCfg }: {
  target: EngineTarget
  cfg: LocalWebSearchRedacted
  setCfg: React.Dispatch<React.SetStateAction<LocalWebSearchRedacted | null>>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState<WebSearchProvider | null>(null)
  const [keyFor, setKeyFor] = useState<Keyed | null>(null) // 正在填 Key 的源(连接 / 更换共用一份草稿)
  const [draft, setDraft] = useState('')
  const [keyErr, setKeyErr] = useState<{ msg: string; force: boolean } | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [busy, setBusy] = useState<Partial<Record<WebSearchProvider, boolean>>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [undo, setUndo] = useState<WebSearchProvider[] | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [drag, setDrag] = useState<WebSearchProvider | null>(null)
  const [drop, setDrop] = useState<{ p: WebSearchProvider; after: boolean } | null>(null)
  // 写排队 + 轮到时读最新配置:两次写不并发读改写,测 Key 期间别处改了顺序也不会被旧快照盖掉
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const keyOp = useRef(0) // 填 Key 这一次操作的令牌:取消 / 换表单 / 断开 / 卸载都作废它,测完回来就不再写
  useEffect(() => () => { keyOp.current++; if (undoTimer.current) clearTimeout(undoTimer.current) }, [])

  const order = cfg.order ?? []
  const off = ALL.filter((p) => !order.includes(p))
  const name = (p: WebSearchProvider) => t(`websearch.name.${p}`)
  const linked = (p: WebSearchProvider) => p === 'duckduckgo' || !!cfg[`${p as Keyed}HasKey`]

  const undoRef = useRef<WebSearchProvider[] | null>(null) // 排队中的撤销轮到时核对:中间夹了别的写就作废
  undoRef.current = undo
  const disarmUndo = () => { if (undoTimer.current) clearTimeout(undoTimer.current); undoTimer.current = null; undoRef.current = null; setUndo(null) }
  /** 即时写,排队执行;build 轮到时拿最新配置算 payload(返回 null = 不写)。成功用回包里的脱敏配置,
   *  不做乐观更新,失败时屏上仍是引擎里的真状态。任何一次写都作废「撤销」(撤销存的是写之前的整份顺序) */
  const queue = (build: (c: LocalWebSearchRedacted) => LocalWebSearchSave | null): Promise<boolean> => {
    const job = chain.current.then(async () => {
      const body = build(cfgRef.current)
      if (!body) return false
      disarmUndo()
      setSaving(true); setMsg('')
      try { const r = await saveLocalWebSearch(target, body); cfgRef.current = r.config; setCfg(r.config); return true }
      catch (e) { setMsg(t('websearch.saveFail', { msg: e instanceof Error ? e.message : String(e) })); return false }
      finally { setSaving(false) }
    })
    chain.current = job.catch(() => false)
    return job
  }
  /** 改顺序:fn(当时的顺序) → 新顺序;写成功后 5 秒内可撤销 */
  const setOrder = async (fn: (cur: WebSearchProvider[]) => WebSearchProvider[] | null) => {
    let prev: WebSearchProvider[] = []
    const ok = await queue((c) => {
      prev = c.order ?? []
      const next = fn([...prev])
      return next && next.join() !== prev.join() ? { order: next, provider: 'auto' } : null
    })
    if (!ok) return
    setUndo(prev)
    undoTimer.current = setTimeout(() => { undoTimer.current = null; setUndo(null) }, 5000)
  }
  const move = (p: WebSearchProvider, dir: -1 | 1) => void setOrder((o) => {
    const at = o.indexOf(p), to = at + dir
    if (at < 0 || to < 0 || to >= o.length) return null
    o.splice(at, 1); o.splice(to, 0, p)
    return o
  })
  const runTest = async (p: WebSearchProvider, apiKey?: string) => {
    try {
      const r = await testLocalWebSearch(target, { provider: p, apiKey })
      return r.ok ? { ok: true, latencyMs: r.latencyMs, resultCount: r.resultCount, at: Date.now() } : { ok: false, latencyMs: r.latencyMs, error: r.error || 'failed', at: Date.now() }
    } catch (e) { return { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e), at: Date.now() } }
  }
  const testSaved = async (p: WebSearchProvider) => {
    setBusy((b) => ({ ...b, [p]: true }))
    const res = await runTest(p) // 不带 apiKey = 测已保存的
    setCfg((c) => c && { ...c, lastTests: { ...c.lastTests, [p]: res } })
    setBusy((b) => ({ ...b, [p]: false }))
  }
  const testAll = async () => { for (const p of order) await testSaved(p) } // 逐个测:并发会让多家同时计费、延迟也互相干扰
  const openKey = (p: Keyed | null) => { keyOp.current++; setKeyFor(p); setDraft(''); setKeyErr(null) }
  /** 填 Key(连接 / 更换):先拿草稿测一次,通过才写;没通过行内报原因 + 「仍然保存」(余额不足之类 Key 本身没错) */
  const submitKey = async (p: Keyed, force: boolean) => {
    const key = draft.trim()
    if (!key) { setKeyErr({ msg: t('websearch.keyEmpty'), force: false }); return }
    const op = keyOp.current
    setKeyBusy(true); setKeyErr(null)
    try {
      if (!force) {
        const res = await runTest(p, key)
        if (op !== keyOp.current) return
        if (!res.ok) { setKeyErr({ msg: t('websearch.keyTestFail', { err: res.error || '' }), force: true }); return }
      }
      const ok = await queue((c) => {
        if (op !== keyOp.current) return null
        const body: LocalWebSearchSave = { [`${p}ApiKey`]: key }
        if (!c[`${p}HasKey`]) { body.order = insertBeforeDdg(c.order ?? [], p); body.provider = 'auto' }
        return body
      })
      if (ok && op === keyOp.current) openKey(null)
    } finally { setKeyBusy(false) }
  }
  const disconnect = (p: Keyed) => {
    if (!window.confirm(t('websearch.disconnectConfirm', { name: name(p) }))) return
    keyOp.current++ // 正在测的 Key(更换)作废:不能断开之后又被它写回来
    if (open === p) setOpen(null)
    void queue((c) => ({ [`${p}ApiKey`]: '', order: without(c.order ?? [], p), provider: 'auto' }))
  }

  const stat = (p: WebSearchProvider) => {
    if (busy[p]) return <span className="wsc-stat is-idle"><Loader2 size={12} className="spin" />{t('websearch.testing')}</span>
    const r = cfg.lastTests?.[p]
    if (!r) return <span className="wsc-stat is-idle">{t('websearch.untested')}</span>
    if (r.ok) return <span className="wsc-stat is-ok"><Check size={13} />{t('websearch.statOk', { ms: r.latencyMs, n: r.resultCount ?? 0 })}</span>
    const e = r.error || 'failed'
    return <span className="wsc-stat is-bad" title={e}><CircleAlert size={13} />{e.length > 28 ? `${e.slice(0, 27)}…` : e}</span>
  }
  const keyForm = (p: Keyed, label: string) => (
    <div className="wsc-keyform">
      <input type="password" autoComplete="off" autoFocus value={draft} placeholder={t('websearch.keyPh')}
        onChange={(e) => { setDraft(e.target.value); setKeyErr(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter') void submitKey(p, false) }} />
      <button className="btn primary sm" disabled={keyBusy} onClick={() => void submitKey(p, false)}>{keyBusy && <Loader2 size={12} className="spin" />}{label}</button>
      <button className="btn ghost sm" onClick={() => openKey(null)}>{t('websearch.cancel')}</button>
      {keyErr && (
        <div className="wsc-err">
          <span>{keyErr.msg}</span>
          {keyErr.force && <button className="btn ghost sm" disabled={keyBusy} onClick={() => void submitKey(p, true)}>{t('websearch.saveAnyway')}</button>}
        </div>
      )}
    </div>
  )
  const field = (label: string, value: React.ReactNode) => <div className="wsc-f"><span className="wsc-fl">{label}</span><div className="wsc-fv">{value}</div></div>

  const onDragOver = (e: React.DragEvent, p: WebSearchProvider) => {
    if (!drag) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2
    if (!drop || drop.p !== p || drop.after !== after) setDrop({ p, after })
  }
  const onDrop = (e: React.DragEvent, target: WebSearchProvider) => {
    if (!drag) return
    e.preventDefault()
    const from = drag, after = !!drop && drop.p === target && drop.after
    setDrag(null); setDrop(null)
    if (from === target) return
    void setOrder((cur) => {
      const o = without(cur, from), i = o.indexOf(target)
      if (i < 0 || o.length === cur.length) return null // 拖的或落的那项已不在列表里(排队期间被别处改了)
      o.splice(after ? i + 1 : i, 0, from)
      return o
    })
  }

  const row = (p: WebSearchProvider, i: number) => {
    const isOpen = open === p
    return (
      <div key={p} data-ws-item={p}
        className={['wsc-item', drag === p && 'is-ghost', !!drop && drop.p === p && (drop.after ? 'drop-after' : 'drop-before')].filter(Boolean).join(' ')}
        onDragOver={(e) => onDragOver(e, p)} onDrop={(e) => onDrop(e, p)}>
        <div className="wsc-row" draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p); setDrag(p) }}
          onDragEnd={() => { setDrag(null); setDrop(null) }}>
          <span className="wsc-grip"><GripVertical size={14} /></span>
          <span className="wsc-rank">{i + 1}</span>
          <div className="wsc-main"><strong>{name(p)}</strong><small>{t(`websearch.desc.${p}`)}</small></div>
          {stat(p)}
          <div className="wsc-acts">
            <button className="icon-btn wsc-mv" title={t('websearch.moveUp')} aria-label={t('websearch.moveUp')} disabled={i === 0 || saving} onClick={() => move(p, -1)}><ArrowUp size={13} /></button>
            <button className="icon-btn wsc-mv" title={t('websearch.moveDown')} aria-label={t('websearch.moveDown')} disabled={i === order.length - 1 || saving} onClick={() => move(p, 1)}><ArrowDown size={13} /></button>
            <button className="btn ghost sm" disabled={busy[p]} onClick={() => void testSaved(p)}>{t('websearch.test')}</button>
            <button className="icon-btn" aria-expanded={isOpen} title={t(isOpen ? 'websearch.collapse' : 'websearch.expand')}
              onClick={() => { setOpen(isOpen ? null : p); openKey(null) }}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
          </div>
        </div>
        {isOpen && (
          <div className="wsc-exp">
            {field(t('websearch.key'), p === 'duckduckgo'
              ? <span className="wsc-muted">{t('websearch.noKey')}</span>
              : keyFor === p ? keyForm(p, t('websearch.saveKey'))
              : <>
                  <span className="wsc-muted"><KeyRound size={13} />{t('websearch.keySaved')}</span>
                  <button className="btn ghost sm" onClick={() => openKey(p)}>{t('websearch.replace')}</button>
                  <button className="btn ghost sm wsc-danger" disabled={saving} onClick={() => disconnect(p)}>{t('websearch.disconnect')}</button>
                </>)}
            {p === 'zhipu' && field(t('websearch.engine'), (
              <select value={cfg.zhipuEngine || 'search_pro_quark'} disabled={saving} onChange={(e) => { const v = e.target.value; void queue(() => ({ zhipuEngine: v })) }}>
                {ENGINES.map(([v, k]) => <option key={v} value={v}>{t(`settings.websearch.zhipuEngine.${k}`)}</option>)}
              </select>
            ))}
            {order.length > 1 && field(t('websearch.disable'), <>
              <span className="wsc-muted">{t('websearch.disableHint')}</span>
              <button className="btn ghost sm" disabled={saving} onClick={() => { setOpen(null); void setOrder((cur) => (cur.length > 1 ? without(cur, p) : null)) }}>{t('websearch.disable')}</button>
            </>)}
          </div>
        )}
      </div>
    )
  }
  const offRow = (p: WebSearchProvider) => (
    <div key={p} data-ws-off={p} className="wsc-item is-off">
      <div className="wsc-row">
        <span className="wsc-grip" /><span className="wsc-rank" />
        <div className="wsc-main"><strong>{name(p)}</strong><small>{t(`websearch.desc.${p}`)}</small></div>
        <div className="wsc-acts">
          {linked(p)
            ? <>
                <button className="btn ghost sm" disabled={saving} onClick={() => void setOrder((cur) => insertBeforeDdg(cur, p))}>{t('websearch.enable')}</button>
                {p !== 'duckduckgo' && <button className="btn ghost sm wsc-danger" disabled={saving} onClick={() => disconnect(p as Keyed)}>{t('websearch.disconnect')}</button>}
              </>
            : keyFor !== p && <button className="btn ghost sm" onClick={() => openKey(p as Keyed)}>{t('websearch.connect')}</button>}
        </div>
      </div>
      {!linked(p) && keyFor === p && <div className="wsc-exp">{field(t('websearch.key'), keyForm(p, t('websearch.connectTest')))}</div>}
    </div>
  )

  return (
    <div className="settings-sub settings-sub--model wsc">
      <section className="settings-panel">
        <div className="settings-panel-head settings-panel-head--actions">
          <div><strong>{t('websearch.inUse')} <span className="wsc-n">{order.length}</span></strong><p>{t('websearch.intro')}</p></div>
          <div className="settings-panel-actions settings-panel-actions--wide">
            {undo && <>
              <span className="wsc-stat is-ok"><Check size={13} />{t('websearch.orderSaved')}</span>
              <button className="btn ghost sm" disabled={saving} onClick={() => { const back = undo; void queue(() => (undoRef.current === back ? { order: back, provider: 'auto' } : null)) }}><Undo2 size={13} />{t('websearch.undo')}</button>
            </>}
            <button className="btn ghost sm" disabled={!order.length || Object.values(busy).some(Boolean)} onClick={() => void testAll()}>{t('websearch.testAll')}</button>
          </div>
        </div>
        {order.map(row)}
        {!order.length && <div className="wsc-note is-bad">{t('websearch.none')}</div>}
        {msg && <div className="wsc-note is-bad">{msg}</div>}
        <div className="wsc-note"><Info size={13} /><span>{t('websearch.note')}</span></div>
      </section>
      {off.length > 0 && (
        <section className="settings-panel">
          <div className="settings-panel-head"><div><strong>{t('websearch.off')} <span className="wsc-n">{off.length}</span></strong></div></div>
          {off.map(offRow)}
        </section>
      )}
    </div>
  )
}
