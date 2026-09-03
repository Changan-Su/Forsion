/**
 * 「按钮」块(Notion button block 的 Forsion 形态)—— 笔记里一个可点的按钮,点一下跑一条自动化。
 *
 * ## 落盘形态
 * 整个 Amadeus 块**恰好**是一个围栏代码块:
 * ```forsion-button
 * {"v":1,"label":"整理今天的笔记","icon":"✨","triggerId":"w-a1b2c3"}
 * ```
 * 纯 markdown、可 diff、别的编辑器打开就是一段代码(不会毁档)。JSON 坏了 → parse 返回 null,
 * BlockHost 回落成普通代码块把源码原样露出来 —— **绝不自动重写**用户改坏的那段。
 *
 * ## 为什么按钮里只有 triggerId,没有动作
 * 动作**内联**是条提权链:`agent_run` 步骤可指定任意 agent + 任意 prompt,而无人值守 run 强制
 * `approvalMode:'full-auto'` —— 那个 agent 转头自己就能 `run_bash`。于是一篇同步/导入/分享来的
 * 笔记,只要骗你点一次按钮,就等于凭笔记内容凭空发明了一个全权限后台 agent。
 * 所以特权部分只存**引用**:规则本体必须先由人在构建器里保存(=人工预批),按钮只能指向已存在的
 * `cond.type==='manual'` 规则;引擎 fire 端点对 origin='button' 另有两道闸(限 manual + 限 enabled)。
 * 外来笔记里的按钮在本机找不到规则 → 显示「规则不存在」,点了什么也不会发生。
 *
 * UX 上并不因此变成「先去面板建规则」:未配置的按钮点一下就直接开构建器(宿主经 automationBridge
 * 提供),保存时替你建那条 manual 规则并回写 triggerId —— 体感是就地建按钮,落盘的却是引用。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OverlayPortal } from '../../lib/overlayPortal'
import { useEscape } from '../../components/Dialogs'
import { getAutomationBridge, type AutomationRuleInfo } from './automationBridge'
import { registerMessages, useI18n } from '../../../i18n'
import type { ButtonSpec } from './format'

registerMessages({
  'btnblock.running': { zh: '⏳ 执行中…', en: '⏳ Running…' },
  'btnblock.setup': { zh: '＋ 配置按钮', en: '＋ Set up button' },
  'btnblock.untitled': { zh: '未命名按钮', en: 'Untitled button' },
  'btnblock.confirmPrompt': { zh: '{text} — 再点一次确认', en: '{text} — click again to confirm' },
  'btnblock.cancel': { zh: '取消', en: 'Cancel' },
  'btnblock.gearTitle': { zh: '配置', en: 'Configure' },
  'btnblock.errBusy': { zh: '上一次执行还没结束', en: 'The previous run is still going' },
  'btnblock.errFailed': { zh: '执行失败', en: 'Run failed' },
  'btnblock.noBridge': { zh: '当前环境不支持自动化按钮(需要本地引擎)', en: 'Automation buttons are not supported here (a local engine is required)' },
  'btnblock.missing': { zh: '引用的自动化不存在(可能已删除,或这篇笔记来自别处)', en: 'The linked automation no longer exists (it may have been deleted, or this note came from elsewhere)' },
  'btnblock.disabled': { zh: '这条自动化已停用,先在自动化面板启用', en: 'This automation is disabled — enable it in the Automation panel first' },
  'btnblock.doneAgent': { zh: '已执行 {n} 步 · Agent 已启动(仍在后台跑)', en: 'Ran {n} steps · agent started (still running in the background)' },
  'btnblock.done': { zh: '已执行 {n} 步', en: 'Ran {n} steps' },
  'btnblock.dialogTitle': { zh: '按钮', en: 'Button' },
  'btnblock.action': { zh: '动作:{desc}', en: 'Action: {desc}' },
  'btnblock.noRule': { zh: '(规则不存在)', en: '(rule not found)' },
  'btnblock.editActions': { zh: '编辑动作', en: 'Edit actions' },
  'btnblock.fieldName': { zh: '名称', en: 'Name' },
  'btnblock.fieldIcon': { zh: '图标', en: 'Icon' },
  'btnblock.fieldConfirm': { zh: '点击前确认', en: 'Confirm before running' },
  'btnblock.namePlaceholder': { zh: '整理今天的笔记', en: "Organize today's notes" },
  'btnblock.confirmPlaceholder': { zh: '留空 = 点了直接执行', en: 'Leave blank to run immediately' },
  'btnblock.save': { zh: '保存', en: 'Save' },
})

type RunState =
  | { k: 'idle' }
  | { k: 'confirm' }
  | { k: 'running' }
  | { k: 'done'; steps: number; agentStarted: boolean }
  | { k: 'error'; msg: string }

export const ButtonBlock: React.FC<{
  spec: ButtonSpec
  onChange(next: ButtonSpec): void
}> = ({ spec, onChange }) => {
  const { t } = useI18n()
  const bridge = getAutomationBridge()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [run, setRun] = useState<RunState>({ k: 'idle' })
  const [rule, setRule] = useState<AutomationRuleInfo | null | 'loading'>('loading')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // 引用的规则是否还在(被删 / 来自别人的笔记 → 明说,而不是点了没反应)。
  // 刻意不建反向索引:规则那头删除时不知道谁引用了它,运行时按 id 查一次就够。
  const reload = useCallback(() => {
    if (!bridge || !spec.triggerId) { setRule(null); return }
    setRule('loading')
    bridge.getRule(spec.triggerId)
      .then((r) => { if (alive.current) setRule(r) })
      .catch(() => { if (alive.current) setRule(null) })
  }, [bridge, spec.triggerId])
  useEffect(reload, [reload])

  const unconfigured = !spec.triggerId
  const missing = !unconfigured && rule !== 'loading' && rule === null
  const off = rule !== 'loading' && rule !== null && !rule.enabled

  /** 开构建器(新建或改动作链);落地后回写 triggerId + 缺省名。 */
  const openBuilder = async (): Promise<void> => {
    if (!bridge) return
    const wasBlank = !spec.triggerId
    const r = await bridge.editRule(spec.triggerId)
    if (!r || !alive.current) return
    onChange({ ...spec, triggerId: r.id, label: spec.label.trim() || r.desc })
    setRun({ k: 'idle' })
    reload()
    // 第一次配置紧接着弹外观面板:否则「插入按钮 → 只看到自动化构建器」,名称/图标/确认这三项
    // 得等保存完再去点 ⚙ 才发现有(用户实报)。已配过的按钮点 ⚙ 进来改动作,则不再回弹。
    if (wasBlank) setCfgOpen(true)
  }

  const fire = async (): Promise<void> => {
    if (!bridge || !spec.triggerId) return
    setRun({ k: 'running' })
    try {
      const r = await bridge.run(spec.triggerId)
      if (!alive.current) return
      if (r.status === 'busy') { setRun({ k: 'error', msg: t('btnblock.errBusy') }); return }
      if (r.status === 'failed') {
        setRun({ k: 'error', msg: r.steps.find((s) => !s.ok)?.summary || t('btnblock.errFailed') })
        return
      }
      // agent_run 步骤只等到「排队成功」,不等 agent 跑完 —— 文案必须说「已启动」而非「已完成」。
      setRun({ k: 'done', steps: r.steps.length, agentStarted: r.steps.some((s) => s.type === 'agent_run' && s.ok) })
    } catch (e: any) {
      if (alive.current) setRun({ k: 'error', msg: String(e?.message || e) })
    }
  }

  const onClick = (): void => {
    if (!bridge) return
    if (unconfigured) { void openBuilder(); return }
    if (missing || off || run.k === 'running') return
    if (spec.confirm && run.k !== 'confirm') { setRun({ k: 'confirm' }); return }
    void fire()
  }

  // ⚠️ `t` 必须进依赖:切语言时 bridge/missing/off/run 都不变,漏了它这段文案会冻在旧语言里
  // (`t` 的身份随 locale 变,见 i18n.tsx 的 Provider value useMemo)。
  const status = useMemo(() => {
    if (!bridge) return { cls: 'warn', text: t('btnblock.noBridge') }
    if (missing) return { cls: 'warn', text: t('btnblock.missing') }
    if (off) return { cls: 'warn', text: t('btnblock.disabled') }
    if (run.k === 'error') return { cls: 'warn', text: run.msg }
    if (run.k === 'done') {
      return { cls: 'ok', text: run.agentStarted ? t('btnblock.doneAgent', { n: run.steps }) : t('btnblock.done', { n: run.steps }) }
    }
    return null
  }, [bridge, missing, off, run, t])

  return (
    <div className="amx-btnblock">
      <div className="amx-btnblock-row">
        <button
          className="amx-btnblock-btn"
          data-blank={unconfigured || undefined}
          data-confirm={run.k === 'confirm' || undefined}
          disabled={run.k === 'running' || !bridge}
          onClick={onClick}
        >
          {run.k === 'running' ? t('btnblock.running')
            : run.k === 'confirm' ? t('btnblock.confirmPrompt', { text: spec.confirm })
            : unconfigured ? t('btnblock.setup')
            : `${spec.icon || '⚡'} ${spec.label || t('btnblock.untitled')}`}
        </button>
        {run.k === 'confirm' && (
          <button className="amx-btnblock-cancel" onClick={() => setRun({ k: 'idle' })}>{t('btnblock.cancel')}</button>
        )}
        {!unconfigured && (
          <button className="amx-btnblock-gear" title={t('btnblock.gearTitle')} onClick={() => setCfgOpen(true)}>⚙</button>
        )}
      </div>
      {status && <div className={`amx-btnblock-status ${status.cls}`}>{status.text}</div>}
      {cfgOpen && (
        <ButtonConfig
          // key 钉在 triggerId 上:刚建完规则回弹时,确保表单用的是回写后的新 spec(缺省名=规则描述)
          key={spec.triggerId ?? 'new'}
          spec={spec}
          ruleDesc={rule && rule !== 'loading' ? rule.desc : null}
          onChange={onChange}
          onEditActions={() => { setCfgOpen(false); void openBuilder() }}
          onClose={() => setCfgOpen(false)}
        />
      )}
    </div>
  )
}

/** 外观配置(名称/图标/确认文案)+ 一个跳去构建器改动作链的入口。 */
const ButtonConfig: React.FC<{
  spec: ButtonSpec
  ruleDesc: string | null
  onChange(next: ButtonSpec): void
  onEditActions(): void
  onClose(): void
}> = ({ spec, ruleDesc, onChange, onEditActions, onClose }) => {
  const { t } = useI18n()
  useEscape(onClose)
  const [label, setLabel] = useState(spec.label)
  const [icon, setIcon] = useState(spec.icon || '')
  const [confirm, setConfirm] = useState(spec.confirm || '')

  const commit = (): void => {
    onChange({ ...spec, label: label.slice(0, 60), icon: icon.slice(0, 4) || undefined, confirm: confirm.trim() || undefined })
    onClose()
  }

  return (
    <OverlayPortal>
      <div className="dialog-overlay" onMouseDown={onClose}>
        <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="dialog-title">{t('btnblock.dialogTitle')}</div>
          <div className="dialog-msg">
            {t('btnblock.action', { desc: ruleDesc || t('btnblock.noRule') })}
            <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={onEditActions}>{t('btnblock.editActions')}</button>
          </div>
          <div className="amx-btnblock-fields">
            <label>{t('btnblock.fieldName')}<input className="dialog-input" value={label} maxLength={60} placeholder={t('btnblock.namePlaceholder')} onChange={(e) => setLabel(e.target.value)} /></label>
            <label>{t('btnblock.fieldIcon')}<input className="dialog-input icon" value={icon} maxLength={4} placeholder="✨" onChange={(e) => setIcon(e.target.value)} /></label>
            <label>{t('btnblock.fieldConfirm')}<input className="dialog-input" value={confirm} maxLength={200} placeholder={t('btnblock.confirmPlaceholder')} onChange={(e) => setConfirm(e.target.value)} /></label>
          </div>
          <div className="dialog-actions">
            <button className="dialog-btn" onClick={onClose}>{t('btnblock.cancel')}</button>
            <button className="dialog-btn" data-primary onClick={commit}>{t('btnblock.save')}</button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  )
}
