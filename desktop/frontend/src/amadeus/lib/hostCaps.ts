/** 宿主能力门控的**单源**(评审 G2-13):移动端「⋯」菜单与附件卡上曾留着桌面专属的死键 —— 导出 PDF、
 *  在文件管理器中显示、用系统程序打开附件,在移动本地库上全是 no-op,点了没反应。口径同 platform-parity
 *  (留一个点了没反应的按钮比没有更糟):按**宿主能力**门控(桥声明的 hostCaps),不按粗指针门控。
 *  ⚠️ 这里的 `window.amadeus?.hostCaps` / `window.tangu?.mobile` 字面量是 check:parity 的门控台账(GATE_FILES +
 *     KNOWN_GATES),别解构、别起别名 —— 否则正则扫不到 = 假登记。 */

/** 在系统文件管理器里显示:只有桌面有文件管理器(云桥 / Unit 网页 / 移动本地库都声明 false)。 */
export function canRevealInFileManager(): boolean {
  return window.amadeus?.hostCaps?.revealInFileManager !== false
}

/** 导出 PDF。移动端的云桥导出 = window.print(),Android WebView 里是空操作 —— 真机未验,按「死键比没有更糟」
 *  先不给;哪天移动桥接上了系统打印 / 分享,显式声明 `exportPdf: true` 即恢复。 */
export function canExportPdf(): boolean {
  if (window.amadeus?.hostCaps?.exportPdf === false) return false
  if (window.tangu?.mobile && window.amadeus?.hostCaps?.exportPdf !== true) return false
  return true
}

/** 用系统程序打开附件(视频 / 音频 / 其他文件卡的「打开」)。PDF 卡走应用内阅读器,不经这里。 */
export function canOpenAttachment(): boolean {
  return window.amadeus?.hostCaps?.openAttachment !== false
}

/** 插件页「打开插件文件夹」/「创建示例插件」:宿主得有一个用户看得见、能往里放文件的插件目录。
 *  Android App 的插件住在应用私有目录(只经市场装),桥声明 false → 两个按钮不渲染(否则点了没反应)。 */
export function canOpenPluginsFolder(): boolean {
  return window.amadeus?.hostCaps?.pluginsFolder !== false
}

/** 页面版本历史(评审 C-20):快照存在主进程的库外目录,只有桌面主进程桥实现;web 云桥 / 移动本地库 / Unit 网页桥都没有
 *  这组可选成员 → 「版本历史」不渲染。按桥实不实现判,不另起声明位。 */
export function canPageHistory(): boolean {
  return typeof window.amadeus?.listPageHistory === 'function'
}
