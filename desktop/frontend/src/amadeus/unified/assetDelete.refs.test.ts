/**
 * 删图时「牵着哪个文件」只认默认协议的地址(2026-10-09 评审)。
 * 宿主换了显示地址(设备网页版 / 云端库)之后,存盘那一侧靠装上的解析器把地址换回相对路径;但**删文件**这一侧不能借它:
 * 独占判定(主进程 exclusiveAssets)只看得见相对路径的引用,看不见别的笔记里被旧缺陷写坏的 http 资源地址 ——
 * 借了解析器,设备网页版上就会开始问「连文件一起删吗」,而那张图可能正被一篇存量坏笔记引用着。
 * 负对照(实跑过):refTextOf 换回 fromAssetUrl → 第一格红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fragment, Schema } from '@milkdown/kit/prose/model'
import { assetRefs, resetAssetUrlBuilder, setAssetUrlBuilder, toAssetUrl, toDisplayMarkdown } from '@amadeus-shared/assets'

vi.mock('../api', () => ({ amadeus: {} }))
vi.mock('../components/askDeleteAssets', () => ({ askDeleteAssets: vi.fn() }))
vi.mock('../store/pageStore', () => ({ trashVaultFiles: vi.fn() }))

import { amadeus } from '../api'
import { askDeleteAssets } from '../components/askDeleteAssets'
import { trashVaultFiles } from '../store/pageStore'
import { askDeleteRemovedAssets, refTextOf } from './assetDelete'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    image: { group: 'inline', inline: true, attrs: { src: { default: '' }, alt: { default: '' } } },
    text: { group: 'inline' },
  },
})
const imageBlock = (src: string): Fragment => Fragment.from(schema.node('paragraph', null, [schema.node('image', { src })]))

afterEach(() => resetAssetUrlBuilder())

describe('refTextOf: which file a removed block points at', () => {
  it('宿主换了显示地址:装上的解析器认得的地址,这里不认 —— 不产生可删的文件引用', () => {
    const BASE = 'https://unit.example/vault/asset?ref='
    setAssetUrlBuilder((ref) => `${BASE}${encodeURIComponent(ref)}&at=T`, (url) => (url.startsWith(BASE) ? new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('ref') : null))
    const src = toAssetUrl('dir/pic.png')
    expect(src.startsWith(BASE)).toBe(true) // 防空过:显示地址确实是注入的那种
    const text = refTextOf(imageBlock(src))
    expect(text).toBe(`![](${src})`)
    expect(assetRefs(text)).toEqual([])
  })

  it('默认协议(桌面):照旧换回库内路径', () => {
    const text = refTextOf(imageBlock(toAssetUrl('dir/pic.png')))
    expect(text).toBe('![](dir/pic.png)')
    expect(assetRefs(text)).toEqual(['dir/pic.png'])
  })
})

/** 删掉的图片牵着独占表里的哪个文件(2026-10-10)。图片节点的引用到 matches 时已经是库内路径(refTextOf 从显示地址换回来的),
 *  页目录之外的图带着没折叠的 `..`(盘上 `![](../attachments/x.png)` → 显示地址 notes/../attachments/x.png)——
 *  此前只做「相等 / 后缀」比对,这种永远对不上,删块时不问文件。现在折叠后相等也算。
 *  整条链走真的:盘上的那一行 → toDisplayMarkdown 的显示地址 → 图片节点 → refTextOf → askDeleteRemovedAssets。
 *  负对照(都实跑过):matches 去掉「折叠后相等」→ 第 1 格红;改成「按页目录再拼一遍后折叠」→ 第 3 格红(问着去删旧文件)。 */
describe('askDeleteRemovedAssets: which exclusive file a removed image points at', () => {
  /** 盘上的一行图片在 pageDir 的笔记里显示成图片节点,整块删掉;独占表(主进程给的)= exclusive。返回被送进回收站的文件。 */
  const run = async (page: string, storedLine: string, exclusive: string[]): Promise<string[] | null> => {
    const pageDir = page.split('/').slice(0, -1).join('/')
    const src = /\]\(([^)\s]+)/.exec(toDisplayMarkdown(storedLine, pageDir))![1]
    expect(src.startsWith('amadeus-asset://v/')).toBe(true) // 防空过:确实是桌面的显示地址
    vi.mocked(trashVaultFiles).mockClear()
    vi.mocked(askDeleteAssets).mockResolvedValue('with' as never)
    ;(amadeus as { exclusiveAssets?: unknown }).exclusiveAssets = vi.fn(async () => exclusive)
    await askDeleteRemovedAssets(page, refTextOf(imageBlock(src)), '')
    return vi.mocked(trashVaultFiles).mock.calls[0]?.[0] as string[] ?? null
  }

  it('页目录之外的图(../):折叠后对上库根的文件', async () => {
    expect(await run('notes/note.md', '![](../attachments/x.png)', ['attachments/x.png'])).toEqual(['attachments/x.png'])
    expect(await run('a/b/note.md', '![](../../img/y.png)', ['img/y.png'])).toEqual(['img/y.png'])
  })

  it('页目录之下的图、库根笔记里的图照旧', async () => {
    expect(await run('notes/note.md', '![](.amadeus/p.png)', ['notes/.amadeus/p.png'])).toEqual(['notes/.amadeus/p.png'])
    expect(await run('note.md', '![](attachments/x.png)', ['attachments/x.png'])).toEqual(['attachments/x.png'])
  })

  it('⚠️索引落后的那一瞬:独占表里还是页目录下同路径的旧文件,图已经指到库根 —— 不许问着去删旧文件', async () => {
    expect(await run('notes/note.md', '![](../attachments/x.png)', ['notes/attachments/x.png'])).toBeNull()
    expect(await run('notes/note.md', '![](.amadeus/p.png)', ['.amadeus/p.png'])).toBeNull()
  })
})
