/** 内置使用教程(2026-08-31 用户提):一篇**同时兼容文档模式与画布模式**的示范笔记 ——
 *  正文是从上往下读的教程,每张卡片是一课,卡之间的父子关系让文档模式缩进成层级、画布模式排成
 *  思维导图。生成到用户自己的 vault 里(而不是做成只读页面),因为教程讲的每一件事都要能当场上手改。
 *
 *  ⚠️ frontmatter **不手写**:走 compileV4,结构键的发射判据与顺序只有那一份真源(手写一行
 *  `amadeus_canvas:` 就等着哪天 schema 键改了这里悄悄变成一篇「有 canvas 没 schema」的半吊子文件,
 *  而 classifyPageSource 见到那种形态会判 v3 → 拽进 v3 管线改写)。
 *  ⚠️ 卡锚必须**全部**在 cards 里在册,否则 foldCanvas 不认(见 canvas.ts 的 `geo.has`),
 *  正文里的 `<!-- a t1 -->` 就会以字面注释的形态露在教程正文里。 */
import { compileV4 } from '@amadeus-shared/compiler/v4'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { openNote } from './amadeusNav'

export const TUTORIAL_PATH = 'Amadeus 使用教程.md'

/** 一课一张卡。`p` = 父卡锚(层级进 tree);x/y = 画布坐标(左上角),文档模式用不着但要占位。 */
const CARDS: Array<{ id: string; p?: string; x: number; y: number; md: string }> = [
  {
    id: 't1', x: 820, y: 0, md: `## ① 两种视角，同一份内容

右上角的胶囊点一下就换视角，内容一个字都不会变 —— 换的是排版方式，不是文件格式。

画布上的位置存在文件 frontmatter 的 \`amadeus_canvas\` 一行；从没用过画布的笔记，连这一行都不会有。`,
  },
  {
    id: 't2', p: 't1', x: 1340, y: 0, md: `### 文档模式：像文档一样写

- 空行输入 \`/\` 唤出块菜单：标题、列表、待办、表格、代码、数据库、画板……
- markdown 前缀也直接生效：\`# \` 标题、\`- \` 列表、\`- [ ] \` 待办、\`> \` 折叠。
- 每一块左边的 \`⠿\` 拖着排序，点开是块菜单（转换类型、移到新列、变成卡片）。
- \`[[\` 引用另一篇笔记，被引的那篇会自动长出反向链接。`,
  },
  {
    id: 't3', p: 't1', x: 1340, y: 320, md: `### 画布模式：像白板一样摆

- **单击 = 选中，拖动 = 搬家；双击（或选中后按 \`空格\`）才进入编辑。**
- 空白处双击新建一张卡；右键空白：卡片 / 矩形 / 椭圆 / 文本 / Frame / 适应内容。
- 滚轮平移，\`⌘/Ctrl + 滚轮\` 以指针为锚缩放，\`Shift + 滚轮\` 横向平移。
- \`⌘/Ctrl + Z\` 的撤销是**一条时间线**：卡里打的字和画布上的搬动按发生顺序退。`,
  },
  {
    id: 't4', x: 820, y: 700, md: `## ② 卡片 = 可以搬走的一块内容

卡片不是另一种文件，只是给一块内容套了个壳：文档里它是一段普通内容，画布上它是一张能摆的卡。壳随时能拆，拆完内容原地还在。`,
  },
  {
    id: 't5', p: 't4', x: 1340, y: 660, md: `### 变成卡片，以及子卡

- 光标停在某一块 → 输入 \`/卡片\`（或点 \`⠿\` → 卡片），这一块就成了卡。
- **在卡片里再来一次，新卡就是它的子卡**：文档模式里缩进一格并被框住，画布模式里挂到父卡右边。
- 不想要壳了：右键卡片 →「收回文档」，内容原地变回普通段落。`,
  },
  {
    id: 't6', p: 't4', x: 1340, y: 980, md: `### 父子关系怎么用

- 选中一张卡：\`Tab\` 加子卡，\`Enter\` 加同级卡（思维导图的手感）。
- 把一张卡拖到另一张卡边上松手 = 认爹，自动排进它旁边的队列。
- **按住 \`Shift\` 拖动：连同它的全部子卡一起搬**，整支不散架。
- 认了爹的卡在文档里也跟着父卡走 —— 源码里永远排在父卡那一段之内。`,
  },
  {
    id: 't7', x: 820, y: 1380, md: `## ③ 遇到「点了没反应」

画布里的单击被留给了选中与拖动，所以**没进编辑态的卡片，里面的东西点不动**。这不是坏了。`,
  },
  {
    id: 't8', p: 't7', x: 1340, y: 1360, md: `### 待办勾不上 / 双链点不开

- 双击那张卡（或选中它后按 \`空格\`）进入编辑态，再点就正常了。
- 真点上去时界面也会提示一次，不用背。
- 编辑完按 \`Esc\`，或者点卡外的任何地方，就退回到选中态。`,
  },
  {
    id: 't9', x: 820, y: 1700, md: `## ④ 动手区 —— 随便改

- [ ] 双击这张卡进入编辑，把这一项勾掉
- [ ] 点开这个双链试试：[[Amadeus 使用教程]]
- [ ] 在这一行下面的空行按 \`/\`，插入一个表格

改乱了想从头再来：删掉这个文件，再从命令面板（\`⌘/Ctrl + K\`）搜「使用教程」。`,
  },
]

const INTRO = `# 欢迎使用 Amadeus

这篇笔记本身就是示范，随便改（标题栏那个名字才是文件名）。

**先记住三件事：**

- 每一篇笔记就是笔记库（Vault）文件夹里的一个 \`.md\` 文件，纯 markdown，别的编辑器也读得懂。
- 右上角「文档 / 画布」胶囊切换视角：**同一份内容**，一种是从上往下读的文档，一种是随手摆的画布。
- 卡片是两种视角之间的桥：文档里的一块内容，到画布上就是一张能拖的卡。

往下（画布模式里是往右）看，每张卡讲一件事。`

/** 教程笔记的源码。卡片 = 开锚 + 内容 + 闭合符;几何与层级进 amadeus_canvas 单键。 */
export function tutorialSource(): string {
  const body = [
    INTRO,
    ...CARDS.map((c) => `<!-- a ${c.id} -->\n\n${c.md}\n\n<!-- /a ${c.id} -->`),
  ].join('\n\n')
  const tree: Record<string, string> = {}
  for (const c of CARDS) if (c.p) tree[c.id] = c.p
  const canvas = {
    v: 1,
    mode: 'doc', // 先当文档读:第一次打开的人还不知道画布是什么(教程第一课就是切过去看看)
    cards: CARDS.map((c) => ({ ref: c.id, x: c.x, y: c.y, w: 460 })),
    tree,
  }
  return compileV4({ kind: 'structured', fmExtra: '', layout: null, canvas: JSON.stringify(canvas), body })
}

/** 打开教程:没有就生成一份,有就直接开(**绝不覆盖** —— 用户在上面改的东西就是他的笔记了)。
 *  ⚠️ 两处都得出声:没开 vault、写盘失败 —— 命令面板点一下什么都不发生是本仓反复栽的那种「静默失败」。 */
export async function openTutorial(): Promise<void> {
  const toast = (text: string, error = false): void => {
    window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text, error } }))
  }
  const ps = usePageStore.getState()
  if (!ps.vaultRoot) {
    toast('请先打开一个笔记库(Vault),教程会生成到里面')
    return
  }
  try {
    // ⚠️「不存在」必须**两个独立信号都说不存在**才算数(Codex 08-31 high):readTextFile 的 null
    //    既是「没有这个文件」也是「这次读失败」,只认它的话一次读失败就把用户改过的教程整篇覆盖 ——
    //    而 writeTextFile 是原子 rename,覆盖即永久。名册(listPages)取不到时一律保守当「已存在」。
    // ponytail: 真解是主进程开一条 O_EXCL 的「不存在才建」IPC(check-then-write 本身不原子);
    //    为一篇教程开 IPC(preload + ipc + unitWeb 白名单 + 类型)不值,两信号已把窗口收到极小。
    const listed = await amadeus.listPages().catch(() => [TUTORIAL_PATH])
    const exists = listed.includes(TUTORIAL_PATH) || (await amadeus.readTextFile(TUTORIAL_PATH)) != null
    if (!exists) {
      await amadeus.writeTextFile(TUTORIAL_PATH, tutorialSource())
      await ps.refreshPages()
    }
  } catch (e) {
    toast(`教程生成失败:${e instanceof Error ? e.message : String(e)}`, true)
    return
  }
  await openNote(TUTORIAL_PATH)
}
