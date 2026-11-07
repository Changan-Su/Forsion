/** 改动记录的两个去处:打开改过的文件(新标签页,同产物行),打开审阅页(Desk 宽格;Desk 不收文件时开标签页,同后台进程输出)。 */
import { useWorkspace } from '@lcl/engine'
import { useApp } from '../../stores/appStore'
import { deskAcceptsFiles } from '../../amadeus/plugins/deskCompanion'
import { targetFor } from '../../components/InlineFiles'
import { openWsFile } from '../wsFileNav'
import { translate } from '../../i18n'
import { requestReview, type ReviewScope } from './changeTrail'

export const CHANGES_VIEW = 'tangu-changes'

export function openChangedFile(sid: string, path: string): void {
  const st = useApp.getState()
  const sess = st.sessions.find((x) => x.id === sid) || st.archivedSessions.find((x) => x.id === sid)
  // 配置没到时按 project_path 兜底(同 ChatView 的 mvCfg)
  const execMode = st.configBySession[sid]?.execMode ?? (sess?.project_path ? 'host' : 'sandbox')
  openWsFile(targetFor({ name: path.split(/[\\/]/).pop() || path, path }, st.cfg, sid, execMode))
}

const deskHere = (sid: string): boolean =>
  deskAcceptsFiles(!!useApp.getState().desktopConfig?.agentDeskEnabled)
  && !!document.querySelector(`[data-desk-session="${CSS.escape(sid)}"]`)

/** since:打开时「本轮」的起点(审阅页以后跟着最新一轮走;重载后 store 里还没有分界时用它)。 */
export function openChangesReview(sid: string, scope: ReviewScope, focus?: string, since?: number): void {
  const params = { sessionId: sid, scope, ...(focus ? { focus } : {}), ...(since != null ? { since } : {}), path: `changes:${sid}` }
  // 已经开着的审阅页不重挂(参数只在挂载时读),经 store 就地切档、滚过去
  requestReview(sid, scope, focus)
  const st = useApp.getState()
  if (deskHere(sid)) {
    st.deskShowFile(sid, params.path, { type: CHANGES_VIEW, params }, translate('changes.title'))
    if (!st.deskBySession[sid]?.userResized) st.patchDesk(sid, { size: 'wide' })
    return
  }
  useWorkspace.getState().openView(CHANGES_VIEW, params, 'main', { newTab: true })
}
