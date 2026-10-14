/**
 * 「翻译」动作的目标语言(划线条上的那枚;聊天、笔记、插件视图共用)。
 * 值是写给模型看的英文语言名(引擎 /agent/inline 的 language;机器翻译模型那条由服务端收成 target_lang)。
 */
import { currentLocale, type Locale } from './i18n'

/** 结果卡头上能临时换的目标语言。label 是各语言自己的叫法(和语言切换器一样,不进词典)。 */
export const TRANSLATE_LANGUAGES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'Chinese (Simplified)', label: '简体中文' },
  { id: 'English', label: 'English' },
  { id: 'Japanese', label: '日本語' },
  { id: 'Korean', label: '한국어' },
  { id: 'French', label: 'Français' },
  { id: 'German', label: 'Deutsch' },
  { id: 'Spanish', label: 'Español' },
  { id: 'Russian', label: 'Русский' },
]

const count = (s: string, re: RegExp): number => (s.match(re) || []).length

/** 译成界面语言;选中的本来就是界面语言时译成另一种(中文界面 → 英文,英文界面 → 中文)。
 *  ponytail: 按字符集粗判 —— 没有假名的汉字当中文,纯 ASCII 字母当英文;不带变音符的法语 / 西语短句会被当成英文、
 *  全是汉字的日语会被当成中文。判错了在卡头换一下;要更准再接语言检测。 */
export function translateTargetOf(text: string, locale: Locale = currentLocale()): string {
  const letters = text.replace(/[\s\p{P}\p{S}\d]/gu, '')
  if (!letters) return locale === 'zh' ? 'English' : 'Chinese (Simplified)'
  const chinese = !/[぀-ヿ]/.test(letters) && count(letters, /[㐀-鿿豈-﫿]/g) / letters.length > 0.3
  if (locale === 'zh') return chinese ? 'English' : 'Chinese (Simplified)'
  return count(letters, /[A-Za-z]/g) / letters.length > 0.9 ? 'Chinese (Simplified)' : 'English'
}
