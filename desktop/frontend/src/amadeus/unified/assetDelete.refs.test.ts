/**
 * 删图时「牵着哪个文件」只认默认协议的地址(2026-10-09 评审)。
 * 宿主换了显示地址(设备网页版 / 云端库)之后,存盘那一侧靠装上的解析器把地址换回相对路径;但**删文件**这一侧不能借它:
 * 独占判定(主进程 exclusiveAssets)只看得见相对路径的引用,看不见别的笔记里被旧缺陷写坏的 http 资源地址 ——
 * 借了解析器,设备网页版上就会开始问「连文件一起删吗」,而那张图可能正被一篇存量坏笔记引用着。
 * 负对照(实跑过):refTextOf 换回 fromAssetUrl → 第一格红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fragment, Schema } from '@milkdown/kit/prose/model'
import { assetRefs, resetAssetUrlBuilder, setAssetUrlBuilder, toAssetUrl } from '@amadeus-shared/assets'

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

/** 删掉的引用牵着独占表里的哪个文件(2026-10-10)。页目录之外的图片现在落盘成 `../…`;此前带路径的引用只做
 *  「相等 / 后缀」比对,`../attachments/x.png` 对不上主进程给的 `attachments/x.png`,删块时就不问文件了。
 *  负对照(实跑过):matches 改回「target === r || target.endsWith('/' + r)」→ 第 1 / 3 格红。 */
describe('askDeleteRemovedAssets: path refs resolve like resolveAttachment', () => {
  const run = async (page: string, removed: string, exclusive: string[]): Promise<string[] | null> => {
    vi.mocked(trashVaultFiles).mockClear()
    vi.mocked(askDeleteAssets).mockResolvedValue('with' as never)
    ;(amadeus as { exclusiveAssets?: unknown }).exclusiveAssets = vi.fn(async () => exclusive)
    await askDeleteRemovedAssets(page, removed, '')
    return vi.mocked(trashVaultFiles).mock.calls[0]?.[0] as string[] ?? null
  }

  it('`../` 引用:按页目录折叠后对上库根的文件', async () => {
    expect(await run('notes/note.md', '![](../attachments/x.png)', ['attachments/x.png'])).toEqual(['attachments/x.png'])
    expect(await run('a/b/note.md', '![](../../img/y%20z.png)', ['img/y z.png'])).toEqual(['img/y z.png'])
  })

  it('页相对、库内路径、`./` 三种带路径的写法照旧认;裸文件名按文件名认', async () => {
    expect(await run('notes/note.md', '![](.amadeus/p.png)', ['notes/.amadeus/p.png'])).toEqual(['notes/.amadeus/p.png'])
    expect(await run('notes/note.md', '![[attachments/x.png]]', ['attachments/x.png'])).toEqual(['attachments/x.png'])
    expect(await run('notes/note.md', '![](./p.png)', ['notes/p.png'])).toEqual(['notes/p.png'])
    expect(await run('notes/note.md', '![[p.png]]', ['elsewhere/P.png'])).toEqual(['elsewhere/P.png'])
  })

  it('路径对不上的不牵连:同名但在别处的文件、只是后缀相同的路径', async () => {
    expect(await run('notes/note.md', '![](../attachments/x.png)', ['notes/attachments/x.png'])).toBeNull()
    expect(await run('notes/note.md', '![](sub/x.png)', ['other/sub/x.png'])).toBeNull()
  })
})
