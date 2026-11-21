import { describe, expect, it } from 'vitest'
import { refusedBody } from './safetyStop'
import { translateFor } from '../../i18n'
import { SAFETY_STOP_NOTICE } from '../../../../../tangu-agent/src/contracts/safetyStop'

describe('refusedBody(安全审核拦下的回答)', () => {
  it('只有 refused 时才摘末尾那句;zh / en 都认,此前的正文留着', () => {
    expect(refusedBody(SAFETY_STOP_NOTICE.zh, true)).toBe('')
    expect(refusedBody(`先查一下。\n\n${SAFETY_STOP_NOTICE.en}`, true)).toBe('先查一下。')
    expect(refusedBody(SAFETY_STOP_NOTICE.zh, false)).toBe(SAFETY_STOP_NOTICE.zh)
    expect(refusedBody('别的正文', true)).toBe('别的正文')
  })
  it('界面文案与引擎落库的那句逐字一致', () => {
    expect(translateFor('zh', 'chat.refused')).toBe(SAFETY_STOP_NOTICE.zh)
    expect(translateFor('en', 'chat.refused')).toBe(SAFETY_STOP_NOTICE.en)
  })
})
