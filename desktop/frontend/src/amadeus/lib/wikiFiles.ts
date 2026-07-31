/** `[[ ]]` 补全是否收录附件与数据库(设置→笔记,默认开;命令面板也可切)。
 *
 *  弹窗在打字路径上渲染,只能同步读 —— 故进程内缓存一份,首次调用乐观取默认值(开)再异步回填。
 *  设置页/命令切换后调 setWikiFilesEnabled 就地更新,不必等下次 getConfig。 */
let cached: boolean | null = null

export function wikiFilesEnabled(): boolean {
  if (cached === null) {
    cached = true
    void window.tangu?.getConfig?.()
      .then((c) => { cached = c?.notesWikiIncludeFiles !== false })
      .catch(() => {})
  }
  return cached
}

export function setWikiFilesEnabled(v: boolean): void {
  cached = v
}
