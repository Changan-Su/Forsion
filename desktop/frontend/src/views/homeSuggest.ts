/**
 * 手机主页的四条起步建议(手机首次引导方案 A 的落点):走完完整的手机引导后,问候下面出 2×2 四条,点了只填进输入框、不发;
 * 这台设备上发出第一条消息后永久收起。这里只放纯逻辑(单测 homeSuggest.test.ts),界面在 HomepageView。
 */

/** 四条建议的文案键(字典登记在 HomepageView,和 home.* 其它文案放一起)。 */
export const HOME_SUGGEST_KEYS = ['home.suggest.today', 'home.suggest.remind', 'home.suggest.summarize', 'home.suggest.help'] as const

/**
 * 主页一屏放不下时逐级让的档位,从宽到紧;HomepageView 从头试到第一个放得下的,写在根的 data-suggest-fit 上(样式在 homepage.css 文末)。
 * all = 四条 + 全部卡片;rows = 四条 + 卡片只画前两行;two = 前两条 + 卡片只画前两行;none = 这一块不出,卡片照常。
 */
export const SUGGEST_FITS = ['all', 'rows', 'two', 'none'] as const

export interface HomeSuggestGate {
  /** 手机布局(useNativeChromeSpaces;网页版窄屏 / Pad 也是 true,所以还要看 phoneApp)。 */
  phone: boolean
  /** 有 Tangu(没有就没有输入框可填)。 */
  tangu: boolean
  /** 手机 App:phoneGuide() 登记过。桌面、网页版不出。 */
  phoneApp: boolean
  /** 走完完整手机引导时记下的记号还在。 */
  pending: boolean
  /** 引导浮层还开着(手机上它盖在已经挂好的主页上面)。 */
  onboarding: boolean
  /** 这台设备上发过消息(成就计数 chat.send > 0)。 */
  sent: boolean
  /** 输入区展开着:卡片都让位了,建议也让。 */
  composerFocused: boolean
}

export function showHomeSuggest(g: HomeSuggestGate): boolean {
  return g.phone && g.tangu && g.phoneApp && g.pending && !g.onboarding && !g.sent && !g.composerFocused
}

/**
 * 点建议前要不要先问「替换输入框里的内容?」。
 * 没草稿 / 只有空白 / 草稿就是四条建议之一(任一种语言;上一次点建议填进去的)= 不问,直接换;
 * 用户自己打的字、或者有长粘贴 = 问。附件和引用芯片从草稿接缝看不到,不算在内。
 */
export function suggestNeedsConfirm(draft: { text: string; pastes: readonly string[] } | undefined, ours: readonly string[]): boolean {
  if (!draft) return false
  if (draft.pastes.length > 0) return true
  const text = draft.text.trim()
  return text !== '' && !ours.some((s) => s.trim() === text)
}
