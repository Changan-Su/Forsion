/** 导出 PDF 用的编辑器克隆(#amx-print-root 里那份)。
 *  标题框是表单控件:单行 input 克隆出来照样把长标题截断(评审 C-12 / C-24),textarea 的 cloneNode 拿的还是挂载时的
 *  初值(value 不进 DOM)—— 克隆里一律换成静态 h1,内容取宿主里那枚控件**此刻**的值(v3 / v4 标题同一类名)。 */
export function printClone(host: HTMLElement): HTMLElement {
  const clone = host.cloneNode(true) as HTMLElement
  const live = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input.amx-title-input, textarea.amx-title-input')]
  clone.querySelectorAll<HTMLElement>('input.amx-title-input, textarea.amx-title-input').forEach((el, i) => {
    const src = live[i]
    const h = document.createElement('h1')
    h.className = 'amx-title-input amx-title-static'
    h.textContent = src?.value || src?.placeholder || ''
    el.replaceWith(h)
  })
  return clone
}
