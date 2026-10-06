/** 设置 → 插件 → 已安装 里的「默认打开方式」:插件可以接管的内置文件类型(目前只有 PDF)由谁来打开。
 *  偏好与判定都在 pluginStore(findFileType / fileOpenerChoice / setFileOpener);这里只是一排下拉框。 */
import { FileCog } from 'lucide-react'
import { OVERRIDABLE_BUILTIN_SUFFIXES } from '@amadeus-shared/builtinTypes'
import { BUILTIN_OPENER, fileOpenerChoice, setFileOpener, usePluginStore } from '@amadeus/plugins/pluginStore'
import { pluginDisplayName } from '../amadeus/plugins/display'
import { registerMessages, useI18n } from '../i18n'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'

registerMessages({
  'fileopeners.title': { zh: '默认打开方式', en: 'Default openers' },
  'fileopeners.description': {
    zh: '插件可以接管下面这些文件类型。在这里选点开文件时由谁来打开。',
    en: 'Plugins can take over the file types below. Choose what opens them when you click a file.',
  },
  'fileopeners.pdf': { zh: 'PDF 文件', en: 'PDF files' },
  'fileopeners.hint': {
    zh: '自动：有插件接管就用插件，否则用内置阅读器。内置阅读器始终可以从文件的右键菜单进入。',
    en: 'Automatic uses a plugin when one takes over, and the built-in reader otherwise. The built-in reader is always available from the file’s context menu.',
  },
  'fileopeners.auto': { zh: '自动', en: 'Automatic' },
  'fileopeners.builtin': { zh: '内置阅读器', en: 'Built-in reader' },
})

/** 后缀 → 行标题的 i18n 键;表里没有的后缀直接显示后缀本身。 */
const LABEL_KEYS: Record<string, string> = { '.pdf': 'fileopeners.pdf' }

export function FileOpenersPanel() {
  const { t, locale } = useI18n()
  const fileTypes = usePluginStore((s) => s.fileTypes) // 偏好一变这个引用就换(见 setFileOpener)
  const plugins = usePluginStore((s) => s.plugins)
  return (
    <SettingsPanel icon={<FileCog size={16} />} title={t('fileopeners.title')} description={t('fileopeners.description')}>
      <div className="settings-control-list">
        {OVERRIDABLE_BUILTIN_SUFFIXES.map((ext) => {
          const { pick, pluginIds } = fileOpenerChoice(fileTypes, ext)
          const label = LABEL_KEYS[ext] ? t(LABEL_KEYS[ext]) : ext
          return (
            <SettingsRow
              key={ext}
              label={label}
              description={t('fileopeners.hint')}
              control={(
                <select data-file-opener={ext} aria-label={label} value={pick} onChange={(e) => setFileOpener(ext, e.target.value)}>
                  <option value="">{t('fileopeners.auto')}</option>
                  <option value={BUILTIN_OPENER}>{t('fileopeners.builtin')}</option>
                  {pluginIds.map((id) => {
                    const p = plugins.find((x) => x.id === id)
                    return <option key={id} value={id}>{p ? pluginDisplayName(p, locale) : id}</option>
                  })}
                </select>
              )}
            />
          )
        })}
      </div>
    </SettingsPanel>
  )
}
