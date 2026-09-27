import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from '@amadeus/components/Dialogs'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'ultraConfirm.title': { zh: '开启 Ultra？', en: 'Turn on Ultra?' },
  'ultraConfirm.msg': {
    zh: 'Ultra 会把思考拉满，并主动把能并行的活拆给多个子代理同时做。一次任务的 token 消耗可能是平时的数倍，适合大任务。',
    en: 'Ultra maxes out thinking and proactively splits parallelizable work across several subagents. One task can use several times the usual tokens, so it suits big jobs.',
  },
  'ultraConfirm.recommend': {
    zh: '推荐配合「完全放行」使用：多个子代理并行时，每个需要确认的操作都会停下来等你批准。',
    en: 'Full access is recommended: with several subagents running in parallel, every action that needs approval stops and waits for you.',
  },
  'ultraConfirm.fullAccess': { zh: '同时把本会话切到「完全放行」', en: 'Also switch this session to Full access' },
  'ultraConfirm.skip': { zh: '以后不再显示', en: "Don't show this again" },
  'ultraConfirm.confirm': { zh: '开启 Ultra', en: 'Turn on Ultra' },
})

const SKIP_KEY = 'forsion_ultra_confirm_off'

/** 用户勾过「以后不再显示」没有(本机 localStorage,三端同一份;读失败按没勾 —— 宁可多弹一次)。 */
export function ultraConfirmSkipped(): boolean {
  try { return localStorage.getItem(SKIP_KEY) === '1' } catch { return false }
}

/**
 * 手动开启 Ultra 前的确认(09-27 用户要求):说清 token 代价;当前不是「完全放行」时推荐它(并行子代理逐个等审批会停下来),
 * 并给一个缺省**不勾**的「同时切到完全放行」—— 审批档是安全设置,只在用户亲手勾选时才动;「以后不再显示」只在确认时记下。
 * 外壳复用 Amadeus ConfirmDialog(同 RemoveDialog):挂 body;`data-keep-menus` 让模型菜单在弹窗期间不被当成「点到外面」关掉,
 * 确认后滑杆原地切进 Ultra(冲击波照放)。
 */
export function UltraConfirmDialog({ offerFullAccess, onConfirm, onClose }: {
  /** 当前审批档不是「完全放行」、且本会话能改审批档(本机、非团队成员)时才推荐 + 给勾选项。 */
  offerFullAccess: boolean
  onConfirm: (opts: { fullAccess: boolean }) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [fullAccess, setFullAccess] = useState(false)
  const [skip, setSkip] = useState(false)
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }} data-ultra-confirm data-keep-menus>
      <ConfirmDialog
        title={t('ultraConfirm.title')}
        message={t('ultraConfirm.msg')}
        confirmLabel={t('ultraConfirm.confirm')}
        danger={false}
        onConfirm={() => {
          if (skip) { try { localStorage.setItem(SKIP_KEY, '1') } catch { /* 存不上就下次再弹 */ } }
          onConfirm({ fullAccess: offerFullAccess && fullAccess })
        }}
        onClose={onClose}
      >
        {offerFullAccess && <div className="dialog-msg">{t('ultraConfirm.recommend')}</div>}
        {offerFullAccess && (
          <label className="dialog-check" data-ultra-full-access>
            <input type="checkbox" checked={fullAccess} onChange={(e) => setFullAccess(e.target.checked)} />
            <span>{t('ultraConfirm.fullAccess')}</span>
          </label>
        )}
        <label className="dialog-check" data-ultra-skip>
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          <span>{t('ultraConfirm.skip')}</span>
        </label>
      </ConfirmDialog>
    </div>,
    document.body,
  )
}
