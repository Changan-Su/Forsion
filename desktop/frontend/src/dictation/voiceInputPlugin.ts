/**
 * 官方「语音输入」插件(代码内注册的内置插件,id `voice-input`):按全局快捷键,在任何应用的光标处说话输入。
 *
 * 它只是开关和设置:快捷键、胶囊(桌面作用域浮层)、往别的应用写字全在主进程(electron/dictation/),插件只经
 * window.tangu.dictation 这条窄接口 —— 主窗挂租约(插件开着 = 服务开着;停用 / 主窗重载 / 关掉,租约随窗口一起撤)、换快捷键、
 * 读状态、请辅助功能授权。第三方插件的 ctx 上没有这些,ctx.ui.float 也没有桌面档。
 *
 * 缺省关(defaultOff):开了就占一个系统级快捷键,不该在用户不知道的时候出现。装好是空的:不写任何文件、不带示例。
 * macOS / Windows 桌面才注册(window.tangu.dictation 只在这两处有);网页 / 手机没有(那是系统输入法的事)。
 */
import type { AmadeusPlugin } from '../amadeus/plugins/types'
import type { PluginSettingsItem, PluginSettingsPageSchema } from '../../../shared/settingsPage'
import { DICTATION_HOTKEY_PRESETS, type DictationState } from '../../../shared/dictation'
import { registerMessages, translate } from '../i18n'
import { windowKind } from '../windowKind'

registerMessages({
  'dictation.plugin.name': { zh: '语音输入', en: 'Voice input' },
  'dictation.plugin.group': { zh: '语音输入', en: 'Voice input' },
  'dictation.plugin.groupDesc': {
    zh: '在任何应用里按快捷键开始说话，再按一次结束，文字写到光标所在处。用的是「设置 › 语音」里选的语音识别模型。',
    en: 'Press the shortcut in any app and speak, then press it again. The text goes where your cursor is, using the speech model chosen in Settings › Voice.',
  },
  'dictation.plugin.status': { zh: '状态', en: 'Status' },
  'dictation.plugin.on': { zh: '已开启', en: 'On' },
  'dictation.plugin.off': { zh: '未开启', en: 'Off' },
  'dictation.plugin.taken': { zh: '快捷键被别的应用占用了，换一个试试', en: 'Another app is using this shortcut — pick another one' },
  'dictation.plugin.hotkey': { zh: '快捷键', en: 'Shortcut' },
  'dictation.plugin.hotkeyDesc': { zh: '按一次开始，再按一次写入；说话时按 Esc 取消。', en: 'Press once to start and again to insert. Press Esc to cancel.' },
  'dictation.plugin.ax': { zh: '写进别的应用', en: 'Type into other apps' },
  'dictation.plugin.axDesc': {
    zh: 'macOS 要在「隐私与安全性 › 辅助功能」里允许 Forsion，才能把文字粘贴到别的应用。Forsion 自己的输入框不需要。',
    en: 'macOS needs Forsion turned on in Privacy & Security › Accessibility to paste into other apps. Forsion’s own text fields work without it.',
  },
  'dictation.plugin.axAllowed': { zh: '已允许', en: 'Allowed' },
  'dictation.plugin.axAllow': { zh: '去允许', en: 'Allow…' },
  'dictation.plugin.how': { zh: '怎么写进去', en: 'How the text gets in' },
  'dictation.plugin.howDesc': {
    zh: '经剪贴板粘贴，粘完把你原来的剪贴板放回去（这期间别的程序改过剪贴板就不动）。遇到密码框、或者按下快捷键时的那个应用已经不在前台，就不写，胶囊上留「复制」。不保证每个应用都能写进去。',
    en: 'It pastes through the clipboard and then puts your clipboard back (unless something else changed it meanwhile). It skips password fields, and if the app you started in is no longer in front it leaves a Copy button instead. Not every app accepts it.',
  },
  'dictation.plugin.how.value': { zh: '剪贴板 + 粘贴', en: 'Clipboard + paste' },
})

const MAC_KEYS: Record<string, string> = { mod: '⌘', alt: '⌥', shift: '⇧' }
const WIN_KEYS: Record<string, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' }

/** 'alt+shift+space' → ⌥⇧Space / Alt+Shift+Space。 */
export function formatHotkey(hk: string, platform = window.tangu?.platform): string {
  const parts = hk.split('+')
  const key = parts.pop() ?? ''
  const name = key === 'space' ? 'Space' : key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
  if (platform === 'darwin') {
    const order = ['alt', 'shift', 'mod'] // ⌥⇧⌘(系统菜单的排法,⌃ 不在这套写法里)
    return order.filter((m) => parts.includes(m)).map((m) => MAC_KEYS[m]).join('') + name
  }
  return [...['mod', 'alt', 'shift'].filter((m) => parts.includes(m)).map((m) => WIN_KEYS[m]), name].join('+')
}

function schema(s: DictationState | null, api: NonNullable<NonNullable<Window['tangu']>['dictation']>): PluginSettingsPageSchema {
  if (!s) return { state: { kind: 'loading', title: translate('dictation.plugin.name') } }
  const presets: string[] = [...DICTATION_HOTKEY_PRESETS]
  if (!presets.includes(s.hotkey)) presets.push(s.hotkey)
  const items: PluginSettingsItem[] = [
    {
      type: 'value', id: 'status', title: translate('dictation.plugin.status'),
      value: !s.enabled ? translate('dictation.plugin.off') : s.registered ? translate('dictation.plugin.on') : translate('dictation.plugin.taken'),
    },
    {
      type: 'select', id: 'hotkey', title: translate('dictation.plugin.hotkey'), desc: translate('dictation.plugin.hotkeyDesc'),
      value: s.hotkey,
      options: presets.map((hk) => ({ value: hk, label: formatHotkey(hk, s.platform) })),
      onChange: (v) => api.setHotkey(v),
    },
  ]
  if (s.platform === 'darwin') {
    items.push(s.accessibility
      ? { type: 'value', id: 'ax', title: translate('dictation.plugin.ax'), desc: translate('dictation.plugin.axDesc'), value: translate('dictation.plugin.axAllowed') }
      : { type: 'button', id: 'ax', title: translate('dictation.plugin.ax'), desc: translate('dictation.plugin.axDesc'), buttons: [{ label: translate('dictation.plugin.axAllow'), kind: 'primary', onClick: () => api.allowAccessibility() }] })
  }
  items.push({ type: 'value', id: 'how', title: translate('dictation.plugin.how'), desc: translate('dictation.plugin.howDesc'), value: translate('dictation.plugin.how.value') })
  return { groups: [{ id: 'voice-input', icon: 'mic', title: translate('dictation.plugin.group'), desc: translate('dictation.plugin.groupDesc'), items }] }
}

export const voiceInputPlugin: AmadeusPlugin = {
  id: 'voice-input',
  name: '语音输入',
  nameEn: 'Voice input',
  version: '1.0.0',
  description: '按全局快捷键，在任何应用的光标处说话输入（用 Forsion 的语音模型）。',
  descriptionEn: "Press a global shortcut and speak to type at the cursor in any app (uses Forsion's speech model).",
  builtin: true,
  defaultOff: true,
  setup(ctx) {
    const api = window.tangu?.dictation
    if (!api) return
    // 租约只由主窗挂:设置窗 / Mini / 拆出的视图窗里也有一份插件实例,它们只画设置页,不重复挂。
    const holder = windowKind() === 'main'
    if (holder) void api.attach(true).catch((e) => console.warn('[voice-input] attach failed', e))
    ctx.registerSettingsView?.({
      id: 'voice-input',
      mount(el) {
        let state: DictationState | null = null
        const page = ctx.ui?.mountSettingsPage?.(el, schema(state, api))
        const render = (s: DictationState | null): void => { state = s ?? state; page?.update(schema(state, api)) }
        const off = api.onChange(render)
        const refresh = (): void => { void api.state().then(render, () => {}) }
        refresh()
        // 从系统设置里给完辅助功能授权回来:窗口重新聚焦时再读一次
        window.addEventListener('focus', refresh)
        return () => { off(); window.removeEventListener('focus', refresh); page?.dispose() }
      },
    })
    return () => { if (holder) void api.attach(false).catch(() => {}) }
  },
}
