/** 会话里不是用户亲手打的「用户行」:续跑 / 审批回执 / 提问回执 / 后台回报 / 子会话回报 / 别的会话发来的消息。
 *  它们接着上一轮的事做,不算「新的一轮」(末尾清单、右栏进度据此判断这一轮从哪开始)。 */
import { APPROVAL_UPDATE_OPEN, BACKGROUND_UPDATE_OPEN, INQUIRY_UPDATE_OPEN } from '../../../../../tangu-agent/src/contracts/approvalQueue'
import { isContinuationRow } from '../../../../../tangu-agent/src/contracts/turnResume'

export const CHILD_UPDATE_OPEN = '<child_sessions_update>'
export const SESSION_MESSAGE_OPEN = '<session_message '

export function isMachineUserRow(content: string): boolean {
  return isContinuationRow(content) || content.startsWith(APPROVAL_UPDATE_OPEN) || content.startsWith(INQUIRY_UPDATE_OPEN)
    || content.startsWith(BACKGROUND_UPDATE_OPEN) || content.startsWith(CHILD_UPDATE_OPEN) || content.startsWith(SESSION_MESSAGE_OPEN)
}
