/**
 * 设置 → Spaces:列出所有已注册 Space —— 内置只读,用户/市场安装的可卸载。
 * 数据源 = useSpaceStore(与 ribbon 图标同一单例,增删即时反映);卸载复用 userSpaces.deleteUserSpace
 * (按 id→磁盘目录映射删配方 + 撤 ribbon 图标 + 清命名布局)。判定内置/用户用 isUserSpace。
 */
import React from 'react'
import { useSpaceStore, label } from '@lcl/engine'
import { isUserSpace, deleteUserSpace, pluginOfSpace } from '../userSpaces'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { pluginDisplayDescription } from '../amadeus/plugins/display'
import { DEFAULT_SPACE_KEY, LAST_EXIT_SPACE, HOME_SLOT_SPACE, startupSpacePref } from '../spaces'
import { homeSlotSpaceId, setHomeSlotSpace } from '../homeSlot'
import { panelToast } from './PanelNotice'
import { registerMessages, useI18n } from '../i18n'
import { LayoutGrid, Rocket } from 'lucide-react'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'
import { SpaceAppearancePanel } from './SpaceAppearancePanel'

/** 每行副标题 = 这个 Space 是干什么的(走查续五 5.7),不再露内部 id(id 进行的悬停提示)。
 *  内置的在这张表里;插件 Space 用插件 manifest 的说明;都没有就空着,不回退成 id。 */
const BUILTIN_PURPOSE = ['home', 'tangu', 'amadeus', 'calendar', 'inbox', 'agents', 'coding', 'image-studio', 'artificial', 'automation', 'muse', 'public']
registerMessages({
  'settings.spaces.purpose.home': { zh: '壁纸、时钟和完整的输入区，打开 App 先到这里', en: 'Wallpaper, clock and the full input, where the app opens' },
  'settings.spaces.purpose.tangu': { zh: '和 Agent 对话，管理会话与项目', en: 'Chat with agents, manage sessions and projects' },
  'settings.spaces.purpose.amadeus': { zh: '笔记、白板和多维表', en: 'Notes, boards and databases' },
  'settings.spaces.purpose.calendar': { zh: '日程、待办和笔记里的任务', en: 'Events, tasks and tasks from notes' },
  'settings.spaces.purpose.inbox': { zh: 'Agent 的汇报、等你批准的请求和 Muse 的信', en: 'Agent reports, requests waiting for you and letters from Muse' },
  'settings.spaces.purpose.agents': { zh: '每个 Agent 的配置、技能和日程', en: 'Each agent’s settings, skills and schedule' },
  'settings.spaces.purpose.coding': { zh: '新建或打开项目，和 Agent 一起写代码', en: 'Start or open a project and code with an agent' },
  'settings.spaces.purpose.image-studio': { zh: '在画布上构思、生图、导出作品', en: 'Sketch, generate and export on a canvas' },
  'settings.spaces.purpose.artificial': { zh: '这台电脑上做出来的网页应用和插件', en: 'Web apps and plugins made on this computer' },
  'settings.spaces.purpose.automation': { zh: '把重复的事做成工作流', en: 'Turn repeat work into workflows' },
  'settings.spaces.purpose.muse': { zh: 'Muse 写的笔记、草稿和工作日志', en: 'Notes, drafts and logs Muse writes' },
  'settings.spaces.purpose.public': { zh: '你发布过的网站和笔记', en: 'Sites and notes you’ve published' },
})

/** phone = 单列壳:没有 ribbon,主位槽那一格不存在 —— 那一行不出,文案也不提 ribbon / 右键。 */
export const SpacesTab: React.FC<{ phone?: boolean }> = ({ phone }) => {
  const { t, locale } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const plugins = usePluginStore((s) => s.plugins)
  const purpose = (id: string): string => {
    if (BUILTIN_PURPOSE.includes(id)) return t(`settings.spaces.purpose.${id}`)
    const owner = plugins.find((p) => p.id === pluginOfSpace(id))
    return (owner && pluginDisplayDescription(owner, locale)) || ''
  }
  const [startup, setStartup] = React.useState<string>(startupSpacePref)
  const changeStartup = (v: string): void => {
    setStartup(v)
    try { localStorage.setItem(DEFAULT_SPACE_KEY, v) } catch { /* private mode */ }
  }
  // 主位槽:与右键那格改的是同一个键,故这里存的是「当前解析结果」而不是原始设定值 ——
  // 设定指向一个没注册的 Space 时(插件关了 / 单品档案),下拉要显示实际生效的那个。
  const [homeSlot, setHomeSlot] = React.useState<string>(() => homeSlotSpaceId() ?? '')
  const changeHomeSlot = (v: string): void => { setHomeSlot(v); setHomeSlotSpace(v) }
  const homeSlotName = label(spaces.find((sp) => sp.id === homeSlot)?.name ?? '—')

  const uninstall = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(t('spaces.deleteConfirm', { name }))) return
    if (await deleteUserSpace(id)) panelToast(t('settings.spaces.uninstalled', { name }))
  }

  return (
    <>
      {/* 启动时进入哪个 Space:**缺省 = ribbon 主位槽指着的那个**(2026-08-28 改;此前是「上次退出的
          Space」)。另两档:上次退出的 Space(连同当时开着的标签页一起恢复)/ 固定某个 Space ——
          后两者里的「固定」与「主位」冷启动进的都是**那个 Space 自己上次的布局**。
          下面第二行就是主位槽本身,与在 ribbon 那格上右键改的是同一个键。 */}
      <SettingsPanel icon={<Rocket size={16} />} title={t('settings.spaces.startupTitle')} description={phone ? t('settings.spaces.startupHintPhone') : t('settings.spaces.startupHint')}>
        <SettingsRow
          label={t('settings.spaces.startupLabel')}
          control={(
            <select value={startup} onChange={(e) => changeStartup(e.target.value)}>
              <option value={HOME_SLOT_SPACE}>{phone ? t('settings.spaces.homeSlotStartupPhone', { name: homeSlotName }) : t('settings.spaces.homeSlotStartup', { name: homeSlotName })}</option>
              <option value={LAST_EXIT_SPACE}>{t('settings.spaces.lastExit')}</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.id}>{label(sp.name)}</option>)}
            </select>
          )}
        />
        {!phone && <SettingsRow
          label={t('settings.spaces.homeSlotLabel')}
          description={t('settings.spaces.homeSlotHint')}
          control={(
            <select value={homeSlot} onChange={(e) => changeHomeSlot(e.target.value)}>
              {spaces.map((sp) => <option key={sp.id} value={sp.id}>{label(sp.name)}</option>)}
            </select>
          )}
        />}
      </SettingsPanel>

      <SpaceAppearancePanel />

      <SettingsPanel icon={<LayoutGrid size={16} />} title={t('settings.spaces.libraryTitle', { count: spaces.length })} description={phone ? t('settings.spaces.hintPhone') : t('settings.spaces.hint')}>
        <div className="settings-collection-list">
          {spaces.length === 0 && <div className="settings-empty-row">{t('settings.spaces.empty')}</div>}
          {spaces.map((sp) => {
            const name = label(sp.name)
            const user = isUserSpace(sp.id)
            const Icon = sp.icon
            return (
              <div key={sp.id} className="settings-collection-row" title={sp.id}>
                <span className="settings-collection-icon">{Icon ? <Icon size={16} /> : <LayoutGrid size={16} />}</span>
                <span className="settings-collection-name"><strong>{name}</strong>{purpose(sp.id) && <small>{purpose(sp.id)}</small>}</span>
                <span className="settings-badge">{user ? t('settings.spaces.user') : t('settings.spaces.builtin')}</span>
                {user && <button className="btn ghost sm danger-ink" onClick={() => void uninstall(sp.id, name)}>{t('settings.spaces.uninstall')}</button>}
              </div>
            )
          })}
        </div>
      </SettingsPanel>
    </>
  )
}
