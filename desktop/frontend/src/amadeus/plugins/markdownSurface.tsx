import { mountHostReact } from '@lcl/components'
import { Markdown } from '../../components/Markdown'
import { WikiOpensBeside } from '../../components/ChatWikiLink'
import { HostLocaleProvider } from '../../i18n'
import './markdownSurface.css'
import type { PluginMarkdownHandle, PluginMarkdownOptions } from '../../../../shared/markdownEditor'

/** ctx.ui.mountMarkdown:聊天那套只读渲染(GFM、公式、双链点开笔记)。不跑代码块、不开内联嵌入和链接预览卡 —— 插件给的是任意文本。 */
export function mountPluginMarkdown(el: HTMLElement, initial: PluginMarkdownOptions): PluginMarkdownHandle {
  const options = { ...initial }
  const tree = () => (
    <HostLocaleProvider>
      <WikiOpensBeside.Provider value>
        <div className="md-body amx-plugin-md">
          <Markdown content={options.markdown} allowRun={false} breaks />
        </div>
      </WikiOpensBeside.Provider>
    </HostLocaleProvider>
  )
  let alive = true
  const mounted = mountHostReact(el, tree(), () => { alive = false })
  return {
    update(patch) { if (alive) { Object.assign(options, patch); mounted.render(tree()) } },
    dispose: mounted.dispose,
  }
}
