/**
 * 设置 → 高级 里的「允许 Tangu 操作这台手机」一行(经 clientSurfaces 的 SettingsRow 渲染)。
 * 开关**显示的是原生回报的状态**:开启要过原生确认框,JS 这边点了不算数,拒绝后自然弹回关。
 * 开着时下面跟 T2「屏幕操作」小节(PhoneControlSetup);⚠️ 返回 fragment 不包 div,行间分隔线靠相邻兄弟选择器。
 */
import { useState } from 'react'
import { useI18n, registerMessages } from '@/i18n'
import { SettingsRow, SettingsSwitch } from '@/components/SettingsPrimitives'
import { setPhoneControlEnabled, usePhoneControlStatus } from './phoneControl'
import { PhoneControlSetup } from './PhoneControlSetup'

registerMessages({
  'phone.row.label': { zh: '允许 Tangu 操作这台手机', en: 'Allow Tangu to operate this phone' },
  'phone.row.hint': {
    zh: '在这台手机上发起的对话里，Tangu 可以打开 App 和链接、导航、设闹钟与计时、控制媒体和手电筒，并起草短信、邮件、电话和日程；发送、拨打、保存始终由你来按。',
    en: 'In chats started on this phone, Tangu can open apps and links, start navigation, set alarms and timers, control media and the flashlight, and draft messages, emails, calls and events. Sending, calling and saving are always up to you.',
  },
  'phone.row.privacy': {
    zh: '指令与草稿内容会经过 Forsion 云端，并保存在对话记录里。',
    en: 'Commands and draft text pass through Forsion cloud and are stored in the conversation.',
  },
})

export function PhoneControlRow() {
  const { t } = useI18n()
  const status = usePhoneControlStatus()
  const [busy, setBusy] = useState(false)
  const label = t('phone.row.label')
  return (
    <>
      <SettingsRow
        label={label}
        description={<>{t('phone.row.hint')}<br />{t('phone.row.privacy')}</>}
        control={(
          <SettingsSwitch
            checked={!!status?.enabled}
            disabled={busy || !status}
            label={label}
            onChange={(next) => {
              setBusy(true)
              void setPhoneControlEnabled(next).finally(() => setBusy(false))
            }}
          />
        )}
      />
      {status?.enabled && <PhoneControlSetup status={status} />}
    </>
  )
}
