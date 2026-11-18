/** 斜杠菜单首屏「常用」一组 + 桌面悬停预览卡(Notion 对齐 A2)。
 *
 *  - 只改**浏览**(没打字)时的排法:常用的几项按下面的顺序排在最前,原分组里不再重复;打字搜索走原来的
 *    匹配与排序,一点不变(所以这里不碰 SLASH_ITEMS 的行,也不改任何一项的 group / kw)。
 *  - 按 key 引用:还没有的项(如别的分支加的 `toc`)、被关掉的插件项(`callout-note` 来自内置插件「Callout 标注」)
 *    自动跳过,有了就自动进来。
 *  - 预览卡只认真鼠标悬停(pointerType === 'mouse'),键盘上下选、刚打开菜单、触屏都不出。 */
import type { ReactNode } from 'react'
import { registerMessages } from '../../../i18n'
import type { SlashItem } from './MarkdownBlock'
import { slashCategory } from './slashNavigation'

registerMessages({
  'mdblock.group.suggested': { zh: '常用', en: 'Suggested' },
  // 预览卡的一句话(界面文案,zh / en 成对)
  'mdblock.preview.text': { zh: '普通段落，直接开始写。', en: 'A plain paragraph. Just start writing.' },
  'mdblock.preview.todo': { zh: '带方框的待办，点一下勾掉。', en: 'A to-do with a checkbox. Click to check it off.' },
  'mdblock.preview.ul': { zh: '简单的无序列表。', en: 'A simple bulleted list.' },
  'mdblock.preview.ol': { zh: '带编号的列表。', en: 'A list with numbers.' },
  'mdblock.preview.h1': { zh: '大号标题，用来分大节。', en: 'A big heading for main sections.' },
  'mdblock.preview.h2': { zh: '中号标题。', en: 'A medium section heading.' },
  'mdblock.preview.h3': { zh: '小号标题。', en: 'A small section heading.' },
  'mdblock.preview.hn': { zh: '更小一级的标题。', en: 'An even smaller heading.' },
  'mdblock.preview.callout': { zh: '带图标和底色的提示块，放提醒和要点。', en: 'A highlighted block with an icon, for tips and key points.' },
  'mdblock.preview.table': { zh: '简单表格，存成标准 Markdown。', en: 'A simple table, saved as standard Markdown.' },
  'mdblock.preview.image': { zh: '上传或嵌入一张图片。', en: 'Upload or embed an image.' },
  'mdblock.preview.columns': { zh: '这一块和右边新的一栏并排。', en: 'Puts this block side by side with a new column.' },
  'mdblock.preview.toc': { zh: '列出本页标题，点哪跳哪。', en: "Lists this page's headings. Click one to jump there." },
  'mdblock.preview.quote': { zh: '引用一段话。', en: 'Capture a quote.' },
  'mdblock.preview.fold': { zh: '可以展开、收起的块。', en: 'A block you can expand and collapse.' },
  'mdblock.preview.code': { zh: '带语法高亮的代码块。', en: 'A code block with syntax highlighting.' },
  'mdblock.preview.divider': { zh: '一条分隔线，把内容分成几段。', en: 'A line that separates sections.' },
  'mdblock.preview.math': { zh: '用 LaTeX 写一行公式。', en: 'A math equation written in LaTeX.' },
  'mdblock.preview.colorTip': { zh: '也能输入 /蓝色背景、/红色 给这一块上色', en: 'You can also type /blue background or /red to color a block' },
  // 预览小样里的示例字(只在卡片里显示,不落盘)
  'mdblock.preview.sample.title': { zh: '发布节奏', en: 'Release plan' },
  'mdblock.preview.sample.body': { zh: '周四冻结，周五出候选包。', en: 'Freeze on Thursday, ship the candidate on Friday.' },
  'mdblock.preview.sample.item1': { zh: '冻结功能范围', en: 'Freeze the scope' },
  'mdblock.preview.sample.item2': { zh: '安装包签名与公证', en: 'Sign and notarize the build' },
  'mdblock.preview.sample.item3': { zh: '全量推送', en: 'Roll out to everyone' },
  'mdblock.preview.sample.colA': { zh: '指标', en: 'Metric' },
  'mdblock.preview.sample.colB': { zh: '目标', en: 'Target' },
  'mdblock.preview.sample.rowA': { zh: '冷启动', en: 'Cold start' },
  'mdblock.preview.sample.left': { zh: '设计', en: 'Design' },
  'mdblock.preview.sample.right': { zh: '研发', en: 'Engineering' },
  'mdblock.preview.sample.quote': { zh: '先把一件事做到最好。', en: 'Do one thing really well first.' },
})

/** 「常用」的顺序(方案 A2):文本、待办、无序列表、标题 1、标题 2、标注、表格、图片、分栏、目录。
 *  标注 = 内置插件的「提示标注」(`> [!note]`);目录 = 页内目录块(`toc`,另一个分支加)。 */
export const SUGGESTED_SLASH_KEYS: readonly string[] = ['text', 'todo', 'ul', 'h1', 'h2', 'callout-note', 'table', 'image', 'columns', 'toc']

/** 浏览时的清单:「常用」一组排最前(group 改成 label、归到「基础」页),其余照原顺序、去掉已进常用的。
 *  keepElsewhere:不在「基础」页的项(插件页的标注)在原页里也留一份 —— 桌面菜单按页显示,不会同屏重复;
 *  手机块面板是一整张单列清单,传 false 只留常用那一份。 */
export function withSuggestedGroup(items: readonly SlashItem[], label: string, keepElsewhere: boolean): SlashItem[] {
  const byKey = new Map(items.map((it) => [it.key, it]))
  const head: SlashItem[] = []
  for (const key of SUGGESTED_SLASH_KEYS) {
    const it = byKey.get(key)
    if (it) head.push({ ...it, group: label, category: 'basic' })
  }
  const taken = new Set(head.map((it) => it.key))
  return [...head, ...items.filter((it) => !taken.has(it.key) || (keepElsewhere && slashCategory(it) !== 'basic'))]
}

type Tr = (key: string) => string

function Sample({ kind, t, icon }: { kind: string; t: Tr; icon: ReactNode }): ReactNode {
  const title = t('mdblock.preview.sample.title')
  const body = t('mdblock.preview.sample.body')
  const items = [t('mdblock.preview.sample.item1'), t('mdblock.preview.sample.item2'), t('mdblock.preview.sample.item3')]
  switch (kind) {
    case 'text': return <p className="sp-p">{body}</p>
    case 'todo': return <div className="sp-todo">{items.map((s, i) => <div key={i} className="sp-row"><i className="sp-box" data-on={i === 0 || undefined} /><span data-done={i === 0 || undefined}>{s}</span></div>)}</div>
    case 'ul': return <ul className="sp-ul">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    case 'ol': return <ol className="sp-ol">{items.map((s, i) => <li key={i}>{s}</li>)}</ol>
    case 'h1': case 'h2': case 'h3': case 'hn':
      return <div className="sp-h" data-level={kind}>{title}</div>
    case 'callout': return <div className="sp-callout"><div className="sp-callout-title"><span className="sp-callout-icon" aria-hidden>{icon}</span>{title}</div><div>{body}</div></div>
    case 'table':
      return <table className="sp-table"><thead><tr><th>{t('mdblock.preview.sample.colA')}</th><th>{t('mdblock.preview.sample.colB')}</th></tr></thead>
        <tbody><tr><td>{t('mdblock.preview.sample.rowA')}</td><td>1.2 s</td></tr></tbody></table>
    case 'image': return <div className="sp-image" aria-hidden><svg viewBox="0 0 48 32" width="48" height="32"><path d="M4 28 18 12l9 10 6-6 11 12Z" fill="currentColor" opacity=".45" /><circle cx="36" cy="8" r="4" fill="currentColor" opacity=".45" /></svg></div>
    case 'columns': return <div className="sp-cols"><div><b>{t('mdblock.preview.sample.left')}</b><i /><i /></div><div><b>{t('mdblock.preview.sample.right')}</b><i /><i /></div></div>
    case 'toc': return <div className="sp-toc"><div>{title}</div><div data-d="2">{t('mdblock.preview.sample.left')}</div><div data-d="2">{t('mdblock.preview.sample.right')}</div></div>
    case 'quote': return <blockquote className="sp-quote">{t('mdblock.preview.sample.quote')}</blockquote>
    case 'fold': return <div className="sp-fold"><div><span aria-hidden>▾</span>{title}</div><div className="sp-fold-body">{body}</div></div>
    case 'code': return <pre className="sp-code"><code>{'const ship = () => {\n  freeze()\n}'}</code></pre>
    case 'divider': return <div className="sp-divider"><p className="sp-p">{title}</p><hr /><p className="sp-p">{body}</p></div>
    case 'math': return <div className="sp-math">E = mc²</div>
    default: return null
  }
}

/** 哪一项出什么卡:key → 小样种类 + 一句话的键。没有登记的项(插件项、AI 项…)不出卡。 */
const PREVIEWS: Record<string, { sample: string; desc: string }> = {
  text: { sample: 'text', desc: 'mdblock.preview.text' },
  todo: { sample: 'todo', desc: 'mdblock.preview.todo' },
  ul: { sample: 'ul', desc: 'mdblock.preview.ul' },
  ol: { sample: 'ol', desc: 'mdblock.preview.ol' },
  h1: { sample: 'h1', desc: 'mdblock.preview.h1' },
  h2: { sample: 'h2', desc: 'mdblock.preview.h2' },
  h3: { sample: 'h3', desc: 'mdblock.preview.h3' },
  h4: { sample: 'hn', desc: 'mdblock.preview.hn' },
  h5: { sample: 'hn', desc: 'mdblock.preview.hn' },
  h6: { sample: 'hn', desc: 'mdblock.preview.hn' },
  'callout-note': { sample: 'callout', desc: 'mdblock.preview.callout' },
  table: { sample: 'table', desc: 'mdblock.preview.table' },
  image: { sample: 'image', desc: 'mdblock.preview.image' },
  columns: { sample: 'columns', desc: 'mdblock.preview.columns' },
  toc: { sample: 'toc', desc: 'mdblock.preview.toc' },
  quote: { sample: 'quote', desc: 'mdblock.preview.quote' },
  fold: { sample: 'fold', desc: 'mdblock.preview.fold' },
  code: { sample: 'code', desc: 'mdblock.preview.code' },
  divider: { sample: 'divider', desc: 'mdblock.preview.divider' },
  math: { sample: 'math', desc: 'mdblock.preview.math' },
}

export function hasSlashPreview(key: string): boolean {
  return key in PREVIEWS
}

/** 卡片内容(定位由调用方的 OverlayAt 管)。colorTip:整块颜色的斜杠命令在不在(A1 合进来之前不提)。 */
export function SlashPreviewBody({ item, t, colorTip }: { item: SlashItem; t: Tr; colorTip: boolean }): ReactNode {
  const p = PREVIEWS[item.key]
  if (!p) return null
  return <>
    <div className="slash-preview-sample" data-kind={p.sample}><Sample kind={p.sample} t={t} icon={item.icon} /></div>
    <div className="slash-preview-title">{item.label}</div>
    <div className="slash-preview-desc">{t(p.desc)}</div>
    {colorTip && item.key === 'text' && <div className="slash-preview-tip">{t('mdblock.preview.colorTip')}</div>}
  </>
}
