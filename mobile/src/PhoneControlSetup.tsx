/**
 * 设置 → 高级 → 测试性功能里,「允许 Tangu 操作这台手机」打开后跟在它下面的 T2 小节:屏幕操作(伴随包无障碍)。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md §6(status.hands / sdk、openAccessibilitySettings)、§9。
 *
 * 状态**只认原生回报**(伴随包装没装、签名、无障碍、proto);本组件只把它翻成下一步该做什么。
 * 老原生不带 `hands` 字段 = 这个包不支持 T2 → 整节不出(不能当成「未安装」,否则引导用户去装一个用不上的包)。
 * ⚠️ 返回的是一串 SettingsRow 的 fragment,不包 div:行间分隔线靠 `.settings-control-row + .settings-control-row`
 *    相邻兄弟选择器,包一层就静默断线(DESIGN §7 那一类)。
 */
import { useI18n, registerMessages } from '@/i18n'
import { SettingsRow } from '@/components/SettingsPrimitives'
import { openAccessibilitySettings, type HandsState, type PhoneControlStatus } from './phoneControl'

/** 伴随包与本体同一个 release 发;release 资产名含 `Hands`(契约 §9.1),下面的引导按这个认。 */
const RELEASE_URL = 'https://github.com/Changan-Su/Forsion/releases/latest'

registerMessages({
  'phone.setup.label': { zh: '屏幕操作（需要伴随应用）', en: 'Screen control (requires the companion app)' },
  'phone.setup.hint': {
    zh: '让 Tangu 读取屏幕，并在其他 App 里点按、输入和滑动：调系统设置与通知、在内容 App 里搜索浏览、查外卖票务行情、填表和跨 App 搬运文字。',
    en: 'Lets Tangu read the screen and tap, type and scroll in other apps: system settings and notifications, searching and browsing in content apps, lifestyle lookups, filling forms and copying text between apps.',
  },
  'phone.setup.state.missing': { zh: '未安装', en: 'Not installed' },
  'phone.setup.state.signature_mismatch': { zh: '签名不符', en: 'Signature mismatch' },
  'phone.setup.state.disabled': { zh: '无障碍未开启', en: 'Accessibility off' },
  'phone.setup.state.proto_mismatch': { zh: '版本不匹配', en: 'Version mismatch' },
  'phone.setup.state.ready': { zh: '已就绪', en: 'Ready' },

  'phone.setup.install.label': { zh: '安装伴随应用', en: 'Install the companion app' },
  'phone.setup.install.hint': {
    zh: '在发布页下载文件名含「Hands」的 APK 并安装。屏幕操作放在单独的应用里，Forsion 本体不申请无障碍权限。',
    en: 'On the release page, download the APK whose name contains “Hands” and install it. Screen control lives in a separate app so Forsion itself never asks for accessibility access.',
  },
  'phone.setup.reinstall.label': { zh: '重新安装伴随应用', en: 'Reinstall the companion app' },
  'phone.setup.reinstall.hint': {
    zh: '已安装的伴随应用不是 Forsion 签名的，Tangu 不会使用它。请先卸载，再从发布页安装。',
    en: "The installed companion app isn't signed by Forsion, so Tangu won't use it. Uninstall it, then install the one from the release page.",
  },
  'phone.setup.update.label': { zh: '更新伴随应用', en: 'Update the companion app' },
  'phone.setup.update.hint': {
    zh: '伴随应用与当前 Forsion 版本不匹配。请从同一个发布页把两者都装成最新版。',
    en: "The companion app doesn't match this version of Forsion. Install both from the same release.",
  },
  'phone.setup.download': { zh: '下载伴随应用', en: 'Download companion app' },

  'phone.setup.a11y.label': { zh: '开启无障碍服务', en: 'Turn on the accessibility service' },
  'phone.setup.a11y.hint': {
    zh: '在「无障碍」里找到伴随应用的服务并打开。回到 Forsion 后这里会自动刷新。',
    en: "In Accessibility, find the companion app's service and turn it on. This page updates when you come back to Forsion.",
  },
  'phone.setup.a11y.open': { zh: '打开无障碍设置', en: 'Open accessibility settings' },

  'phone.setup.restricted.label': { zh: '开关是灰的？', en: 'Switch greyed out?' },
  // 品牌差异分两处:安装被拦(纯净模式 / 自动拦截器)跟在安装那一步,应用信息的位置跟在受限设置那一步。
  // 各家菜单路径随版本漂移,通用路径写「在设置里搜应用名」兜底。⚠️ 未经真机核对。
  'phone.setup.install.oem': {
    zh: 'HyperOS / MIUI 被「纯净模式」拦下时，在安装页选择仍要安装；One UI 被「自动拦截器」挡住时，先在 设置 → 安全和隐私 → 自动拦截器 里暂时关闭。',
    en: 'If HyperOS / MIUI Pure mode blocks the install, choose to install anyway on the install screen. If One UI Auto Blocker stops it, turn it off for now in Settings → Security and privacy → Auto Blocker.',
  },
  'phone.setup.restricted.hint': {
    zh: 'Android 13 起，应用商店以外安装的应用默认不能开无障碍。先试着打开一次服务（会提示「受限制的设置」），再打开伴随应用的「应用信息」（可在设置顶部搜索它的名字），点右上角 ⋮ → 允许受限制的设置，然后回来重新打开。',
    en: "From Android 13, apps installed outside an app store can't turn on accessibility by default. Try turning the service on once (you'll see “Restricted setting”), then open the companion app's App info (you can search its name in Settings), tap ⋮ at the top right → Allow restricted settings, and try again.",
  },
  'phone.setup.restricted.hyperos': { zh: 'HyperOS / MIUI：设置 → 应用设置 → 应用管理 → 伴随应用', en: 'HyperOS / MIUI: Settings → Apps → Manage apps → the companion app' },
  'phone.setup.restricted.coloros': { zh: 'ColorOS / OxygenOS：设置 → 应用 → 应用管理 → 伴随应用', en: 'ColorOS / OxygenOS: Settings → Apps → App management → the companion app' },
  'phone.setup.restricted.oneui': { zh: 'One UI：设置 → 应用程序 → 伴随应用', en: 'One UI: Settings → Apps → the companion app' },

  'phone.setup.limits.label': { zh: '边界与隐私', en: 'Limits and privacy' },
  'phone.setup.limits.apps': {
    zh: '微信只读不操作；支付宝、银联与常见银行、证券 App 对 Tangu 不可见。',
    en: 'WeChat is read-only; Alipay, UnionPay and common banking and brokerage apps are hidden from Tangu.',
  },
  'phone.setup.limits.commit': {
    zh: '遇到发送、支付、下单时 Tangu 会停下交给你来按。这项判断靠按钮文字，纯图标按钮可能漏判，操作时请留意屏幕。',
    en: 'Tangu pauses and hands back to you before sending, paying or ordering. This check relies on button labels and can miss icon-only buttons, so keep an eye on the screen.',
  },
  // 不写具体分钟数:租约时长以原生为准(浮层里经 {minutes} 填),这里写死会静默漂移。
  'phone.setup.limits.lease': {
    zh: '每次开始前会先征得你同意（限时有效），屏幕边缘的按钮随时可以结束。',
    en: 'It asks for your permission before it starts, for a limited time, and the button at the edge of the screen ends it at any time.',
  },
  'phone.setup.limits.cloud': {
    zh: '屏幕上的文字会发送到 Forsion 云端，并保存在对话记录里。',
    en: 'Screen text is sent to Forsion cloud and stored in the conversation.',
  },
})

function openRelease(): void {
  // ⚠️ 走 mobileShim 的 openExternal(底下就是 Capacitor Browser),别直接 import @capacitor/browser:
  //    web 整份复用移动端的壳,web 构建的 capacitor 桩闸会把直接 import 当成红灯(09-26 三平台 CI 实翻)。
  void window.tangu?.openExternal?.(RELEASE_URL)?.catch((e) => console.warn('[phone-control] open release page failed:', e))
}

export function PhoneControlSetup({ status }: { status: PhoneControlStatus }) {
  const { t } = useI18n()
  // ⚠️ 一律写成字面量 t('…'):i18nCoverage 的 C 条只认字面量调用,键表里放裸键字符串的话拼错了不会红,
  //    界面上直接渲染键名。Record<HandsState, …> 保证新增状态时这里编译不过。
  const stateText: Record<HandsState, string> = {
    missing: t('phone.setup.state.missing'),
    signature_mismatch: t('phone.setup.state.signature_mismatch'),
    proto_mismatch: t('phone.setup.state.proto_mismatch'),
    disabled: t('phone.setup.state.disabled'),
    ready: t('phone.setup.state.ready'),
  }
  const hands = status.hands
  if (!hands || !Object.hasOwn(stateText, hands)) return null // 老原生 / 未知状态:这个包不支持 T2
  const installSteps: Partial<Record<HandsState, { label: string; hint: string }>> = {
    missing: { label: t('phone.setup.install.label'), hint: t('phone.setup.install.hint') },
    signature_mismatch: { label: t('phone.setup.reinstall.label'), hint: t('phone.setup.reinstall.hint') },
    proto_mismatch: { label: t('phone.setup.update.label'), hint: t('phone.setup.update.hint') },
  }
  const install = installSteps[hands]
  return (
    <>
      <SettingsRow
        label={t('phone.setup.label')}
        description={t('phone.setup.hint')}
        control={<span className="settings-badge">{stateText[hands]}</span>}
      />
      {install && (
        <SettingsRow
          label={install.label}
          description={<>{install.hint}<br />{t('phone.setup.install.oem')}</>}
          control={<button type="button" className="btn ghost sm" onClick={openRelease}>{t('phone.setup.download')}</button>}
        />
      )}
      {hands === 'disabled' && (
        <SettingsRow
          label={t('phone.setup.a11y.label')}
          description={t('phone.setup.a11y.hint')}
          control={(
            <button type="button" className="btn ghost sm" onClick={() => void openAccessibilitySettings()}>
              {t('phone.setup.a11y.open')}
            </button>
          )}
        />
      )}
      {/* 受限设置从 Android 13(API 33)起才有;原生没报 sdk 时宁可多给一段说明。 */}
      {hands === 'disabled' && (status.sdk ?? 33) >= 33 && (
        <SettingsRow
          label={t('phone.setup.restricted.label')}
          description={(
            <>
              {t('phone.setup.restricted.hint')}
              <br />· {t('phone.setup.restricted.hyperos')}
              <br />· {t('phone.setup.restricted.coloros')}
              <br />· {t('phone.setup.restricted.oneui')}
            </>
          )}
        />
      )}
      <SettingsRow
        label={t('phone.setup.limits.label')}
        description={(
          <>
            {t('phone.setup.limits.apps')}
            <br />{t('phone.setup.limits.commit')}
            <br />{t('phone.setup.limits.lease')}
            <br />{t('phone.setup.limits.cloud')}
          </>
        )}
      />
    </>
  )
}
