/** 内置浏览器(builtin:browser)的 <webview> 会话分区 —— 主进程与渲染层同源引用。
 *  独立分区 = 与 App 自身 cookie/storage 隔离,且不继承 defaultSession 的「权限全放行」策略。 */
export const BROWSER_PARTITION = 'persist:forsion-browser'
