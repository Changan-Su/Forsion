// 全局测试前置:把界面语言钉成 zh。
// 为什么需要:文案 i18n 化之后,任何断言中文串的测试都变成「看跑测机器系统语言的脸色」——
// 本机 macOS 是 en-GB,resolveInitialLocale() 于是给 en,dateQuery.test 的 '9月1日' 当场变 '9/1'。
// 钉死在这里,单个用例要验 en 侧就自己 setLocaleGlobal('en') 再复位(见 rowLinkLocale / dateUtilsLocale)。
import { setLocaleGlobal } from './i18n'
setLocaleGlobal('zh')
