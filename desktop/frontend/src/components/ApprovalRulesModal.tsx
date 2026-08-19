/**
 * custom 审批档的规则编辑器(H2)。此前这套规则引擎只能手写 `~/.tangu/config.json`。
 *
 * 两件必须写在界面上、否则没人能正确使用的事:
 *   ① 规则是**全局**的(存 config.json,跨会话生效);**档位才是按会话**。
 *   ② 规则语法是自造的(`工具名[*][:参数前缀]`),不给例子没人会写。
 * 三个列表按引擎的判定优先级排(deny > ask > allow > base),顺序本身是信息,别按字母序。
 *
 * 引擎每次工具调用现读 config.json → 保存后**下一次工具调用**即生效,不用重启。
 * 外壳照 AgentMemoryModal 的形状(内联样式 + 通用类),不引 `.dialog-*`——那套是 Amadeus 侧的 token。
 */
import React, { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { useI18n } from '../i18n'
import * as api from '../services/backendService'
import type { ApprovalRules } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { MODE_KEY } from './ApprovalCard'

const BASES: ApprovalRules['base'][] = ['readonly', 'auto-edit', 'full-auto']
const EMPTY: ApprovalRules = { base: 'auto-edit', allow: [], ask: [], deny: [] }

/**
 * 文本域 ↔ 规则数组:一行一条,去空行与首尾空格(与服务端 ruleList 同语义,省得两边不一致)。
 * ⚠️ **只在保存时做这次归一化**。第一版把它挂在受控 textarea 的 onChange 上,每次击键都归一:
 *   敲回车 → 尾部空行被 filter 掉 → React 把值改回单行 = **第二条规则永远打不出来**;
 *   行尾打空格 → 该行被 trim → `run_bash:npm test` 会打成 `run_bash:npmtest`(语义完全不同,且无提示)。
 * 所以编辑期存的是**原始文本**,数组只在 save() 那一刻算。
 */
const toLines = (v: string[]): string => v.join('\n')
const fromLines = (v: string): string[] => v.split('\n').map((x) => x.trim()).filter(Boolean)

export const ApprovalRulesModal: React.FC<{ cfg: TanguDesktopConfig; onClose: () => void }> = ({ cfg, onClose }) => {
  const { t } = useI18n()
  const [base, setBase] = useState<ApprovalRules['base']>(EMPTY.base)
  const [text, setText] = useState<Record<'deny' | 'ask' | 'allow', string>>({ deny: '', ask: '', allow: '' })
  const [loading, setLoading] = useState(true)
  /** 读成功过没有。**没读到就绝不给保存** —— 见下。 */
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // cfg 走 ref:它在后端**每次重连**时都会被换成新对象(appStore 的 onBackendStatus ready 分支)。
  // 若 load 依赖 cfg,弹层开着时重连一次就重跑 GET → setText 覆盖用户正在写的规则 = H1 那类数据丢失换个门再来一次。
  const cfgRef = React.useRef(cfg)
  cfgRef.current = cfg

  const load = React.useCallback((): void => {
    setLoading(true)
    setErr('')
    api.getApprovalRules(cfgRef.current)
      .then((r) => {
        setBase(r.base)
        setText({ deny: toLines(r.deny), ask: toLines(r.ask), allow: toLines(r.allow) })
        setLoaded(true)
        setLoading(false)
      })
      .catch((e: any) => { setErr(String(e?.message || e)); setLoaded(false); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load]) // load 无依赖 → 只在挂载时读一次

  const save = async (): Promise<void> => {
    if (!loaded) return
    setSaving(true)
    setErr('')
    try {
      await api.putApprovalRules(cfgRef.current, {
        base, deny: fromLines(text.deny), ask: fromLines(text.ask), allow: fromLines(text.allow),
      })
      onClose()
    } catch (e: any) {
      setErr(String(e?.message || e))   // 失败不关窗:关掉的话用户白写一屏规则
      setSaving(false)
    }
  }

  const list = (k: 'deny' | 'ask' | 'allow'): React.ReactElement => (
    <div className="field" key={k}>
      <label><b>{t(`approvalRules.${k}` as any)}</b></label>
      <div className="hint">{t(`approvalRules.${k}Hint` as any)}</div>
      <textarea
        value={text[k]}
        onChange={(e) => setText((v) => ({ ...v, [k]: e.target.value }))}
        rows={3}
        spellCheck={false}
        placeholder={t(`approvalRules.${k}Ph` as any)}
        style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
      />
    </div>
  )

  return (
    <div
      className="apvr-modal"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 12px)', padding: 18, width: 'min(620px, 92vw)', maxHeight: '86vh', overflow: 'auto', boxShadow: 'var(--card-shadow)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <b>{t('approvalRules.title')}</b>
          <button className="icon-btn" onClick={onClose}><X size={15} /></button>
        </div>

        {loading ? (
          <div className="field"><div className="hint"><Loader2 size={14} className="spin" /> {t('common.loading')}</div></div>
        ) : !loaded ? (
          // ⚠️ 读失败时**绝不渲染表单**:空表单与「从没配过」长得一模一样,用户没细看错误行就点保存,
          //    PUT 全量四字段 = 把 deny/ask/allow 整片清空落盘(丢的正好是安全控制项,且没有撤销)。
          <div className="field">
            <div className="hint" style={{ color: 'var(--danger)' }}>{t('approvalRules.loadFailed')}</div>
            <div className="hint">{err}</div>
            <div style={{ marginTop: 8 }}>
              <button className="btn sm ghost" onClick={load}>{t('common.retry')}</button>
            </div>
          </div>
        ) : (
          <>
            {/* 必须包在 .field 里:`.hint` 的样式定义是 `.field .hint`(base.css),裸着用就按正文字号渲染,
                而这两行正是「不写没人会用」的作用域警告与语法说明。 */}
            <div className="field">
              <div className="hint">{t('approvalRules.scopeNote')}</div>
              <div className="hint" style={{ marginTop: 4 }}>{t('approvalRules.syntax')}</div>
            </div>

            <div className="field">
              <label><b>{t('approvalRules.base')}</b></label>
              <div className="hint">{t('approvalRules.baseHint')}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {BASES.map((b) => (
                  <button
                    key={b}
                    className={`btn sm${base === b ? ' primary' : ' ghost'}`}
                    onClick={() => setBase(b)}
                  >{t(MODE_KEY[b] as any)}</button>
                ))}
              </div>
            </div>

            {(['deny', 'ask', 'allow'] as const).map(list)}

            {err && <div className="field"><div className="hint" style={{ color: 'var(--danger)' }}>{err}</div></div>}
          </>
        )}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn ghost sm" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary sm" disabled={!loaded || saving} onClick={() => void save()}>
            {saving ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
