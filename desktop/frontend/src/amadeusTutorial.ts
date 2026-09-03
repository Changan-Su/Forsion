/** 内置使用教程(2026-08-31 用户提):一篇**同时兼容文档模式与画布模式**的示范笔记 ——
 *  正文是从上往下读的教程,每张卡片是一课,卡之间的父子关系让文档模式缩进成层级、画布模式排成
 *  思维导图。生成到用户自己的 vault 里(而不是做成只读页面),因为教程讲的每一件事都要能当场上手改。
 *
 *  ⚠️ frontmatter **不手写**:走 compileV4,结构键的发射判据与顺序只有那一份真源(手写一行
 *  `amadeus_canvas:` 就等着哪天 schema 键改了这里悄悄变成一篇「有 canvas 没 schema」的半吊子文件,
 *  而 classifyPageSource 见到那种形态会判 v3 → 拽进 v3 管线改写)。
 *  ⚠️ 卡锚必须**全部**在 cards 里在册,否则 foldCanvas 不认(见 canvas.ts 的 `geo.has`),
 *  正文里的 `<!-- a t1 -->` 就会以字面注释的形态露在教程正文里。
 *
 *  ⚠️ 课文**不能**是模块级字面量:模块级常量在 import 那一刻就冻住,之后切语言不会重算。
 *  CARDS 只存 i18n 键与几何,课文一律在 tutorialSource() 里 translate() —— 那是「按下生成」
 *  的时刻,取到的才是用户当下的界面语言。 */
import { compileV4 } from '@amadeus-shared/compiler/v4'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { registerMessages, translate } from './i18n'
import { openNote } from './amadeusNav'

/** ⚠️ 文件名,不是文案:它同时是 listPages 的比对键、readTextFile/writeTextFile 的路径、
 *  openNote 的目标,还落在用户磁盘上。翻译它 = 换语言就多生成一份教程、且旧的那份再也认不出来。 */
export const TUTORIAL_PATH = 'Amadeus 使用教程.md'
/** 教程里那条 `[[双链]]` 的落点。从 TUTORIAL_PATH 推,别在文案里再抄一份文件名。 */
const TUTORIAL_LINK = TUTORIAL_PATH.replace(/\.md$/i, '')

registerMessages({
  'amtut.intro': {
    zh: `# 欢迎使用 Amadeus

这篇笔记本身就是示范，随便改（标题栏那个名字才是文件名）。

**先记住三件事：**

- 每一篇笔记就是笔记库（Vault）文件夹里的一个 \`.md\` 文件，纯 markdown，别的编辑器也读得懂。
- 右上角「文档 / 画布」胶囊切换视角：**同一份内容**，一种是从上往下读的文档，一种是随手摆的画布。
- 卡片是两种视角之间的桥：文档里的一块内容，到画布上就是一张能拖的卡。

往下（画布模式里是往右）看，每张卡讲一件事。`,
    en: `# Welcome to Amadeus

This note is the demo itself — change anything you like (the name in the title bar is the file name).

**Three things to know first:**

- Every note is a single \`.md\` file inside your vault folder: plain markdown, readable in any other editor.
- The "Doc / Canvas" pill in the top right switches the view: **the same content**, either as a document you read top to bottom or as a canvas you arrange by hand.
- Cards are the bridge between the two views: a chunk of content in the document becomes a card you can drag on the canvas.

Read on — to the right, in canvas mode. Each card covers one thing.`,
  },
  'amtut.card.t1': {
    zh: `## ① 两种视角，同一份内容

右上角的胶囊点一下就换视角，内容一个字都不会变 —— 换的是排版方式，不是文件格式。

画布上的位置存在文件 frontmatter 的 \`amadeus_canvas\` 一行；从没用过画布的笔记，连这一行都不会有。`,
    en: `## ① Two views, one set of content

Click the pill in the top right to switch views — not one character of the content changes. What changes is the layout, not the file format.

Positions on the canvas live in a single \`amadeus_canvas\` line in the file's frontmatter; a note that has never used the canvas does not even have that line.`,
  },
  'amtut.card.t2': {
    zh: `### 文档模式：像文档一样写

- 空行输入 \`/\` 唤出块菜单：标题、列表、待办、表格、代码、数据库、画板……
- markdown 前缀也直接生效：\`# \` 标题、\`- \` 列表、\`- [ ] \` 待办、\`> \` 折叠。
- 每一块左边的 \`⠿\` 拖着排序，点开是块菜单（转换类型、移到新列、变成卡片）。
- \`[[\` 引用另一篇笔记，被引的那篇会自动长出反向链接。`,
    en: `### Doc mode: write like a document

- Type \`/\` on an empty line to open the block menu: heading, list, to-do, table, code, database, drawing board and more.
- Markdown prefixes work directly too: \`# \` heading, \`- \` list, \`- [ ] \` to-do, \`> \` toggle.
- Drag the \`⠿\` handle on the left of a block to reorder it; click it for the block menu (change type, move to a new column, turn into a card).
- \`[[\` links to another note, and the note you link to grows a backlink automatically.`,
  },
  'amtut.card.t3': {
    zh: `### 画布模式：像白板一样摆

- **单击 = 选中，拖动 = 搬家；双击（或选中后按 \`空格\`）才进入编辑。**
- 空白处双击新建一张卡；右键空白：卡片 / 矩形 / 椭圆 / 文本 / Frame / 适应内容。
- 滚轮平移，\`⌘/Ctrl + 滚轮\` 以指针为锚缩放，\`Shift + 滚轮\` 横向平移。
- \`⌘/Ctrl + Z\` 的撤销是**一条时间线**：卡里打的字和画布上的搬动按发生顺序退。`,
    en: `### Canvas mode: arrange like a whiteboard

- **Click = select, drag = move; double-click (or press \`Space\` with the card selected) to start editing.**
- Double-click empty space to add a card; right-click empty space for Card / Rectangle / Ellipse / Text / Frame / Fit to content.
- Scroll to pan, \`⌘/Ctrl + scroll\` to zoom around the pointer, \`Shift + scroll\` to pan sideways.
- \`⌘/Ctrl + Z\` undoes along **one timeline**: text typed inside a card and moves made on the canvas unwind in the order they happened.`,
  },
  'amtut.card.t4': {
    zh: `## ② 卡片 = 可以搬走的一块内容

卡片不是另一种文件，只是给一块内容套了个壳：文档里它是一段普通内容，画布上它是一张能摆的卡。壳随时能拆，拆完内容原地还在。`,
    en: `## ② A card is a chunk of content you can move

A card is not another kind of file, just a shell around a chunk of content: in the document it is an ordinary passage, on the canvas it is a card you can place. The shell comes off whenever you want, and the content stays right where it was.`,
  },
  'amtut.card.t5': {
    zh: `### 变成卡片，以及子卡

- 光标停在某一块 → 输入 \`/卡片\`（或点 \`⠿\` → 卡片），这一块就成了卡。
- **在卡片里再来一次，新卡就是它的子卡**：文档模式里缩进一格并被框住，画布模式里挂到父卡右边。
- 不想要壳了：右键卡片 →「收回文档」，内容原地变回普通段落。`,
    en: `### Turning a block into a card, and adding child cards

- Put the cursor in a block and type \`/card\` (or click \`⠿\` → Card) to turn that block into a card.
- **Do it again inside a card and the new card becomes its child**: indented and boxed in doc mode, attached to the right of its parent on the canvas.
- Done with the shell? Right-click the card → "Unwrap into document", and the content turns back into an ordinary paragraph in place.`,
  },
  'amtut.card.t6': {
    zh: `### 父子关系怎么用

- 选中一张卡：\`Tab\` 加子卡，\`Enter\` 加同级卡（思维导图的手感）。
- 把一张卡拖到另一张卡边上松手 = 认爹，自动排进它旁边的队列。
- **按住 \`Shift\` 拖动：连同它的全部子卡一起搬**，整支不散架。
- 认了爹的卡在文档里也跟着父卡走 —— 源码里永远排在父卡那一段之内。`,
    en: `### What the parent-child link is good for

- With a card selected: \`Tab\` adds a child card, \`Enter\` adds a sibling — the mind-map feel.
- Drop a card next to another one and it becomes that card's child, slotting into the queue beside it.
- **Hold \`Shift\` while dragging to move a card together with every one of its children** — the whole branch stays intact.
- A card with a parent follows that parent in the document too: in the source it always sits inside the parent's section.`,
  },
  'amtut.card.t7': {
    zh: `## ③ 遇到「点了没反应」

画布里的单击被留给了选中与拖动，所以**没进编辑态的卡片，里面的东西点不动**。这不是坏了。`,
    en: `## ③ When clicking seems to do nothing

On the canvas a single click is reserved for selecting and dragging, so **nothing inside a card responds until that card is in edit mode**. It is not broken.`,
  },
  'amtut.card.t8': {
    zh: `### 待办勾不上 / 双链点不开

- 双击那张卡（或选中它后按 \`空格\`）进入编辑态，再点就正常了。
- 真点上去时界面也会提示一次，不用背。
- 编辑完按 \`Esc\`，或者点卡外的任何地方，就退回到选中态。`,
    en: `### To-dos will not tick, wikilinks will not open

- Double-click the card (or select it and press \`Space\`) to enter edit mode, and clicking works as usual.
- The app reminds you once when you actually try it, so there is nothing to memorize.
- Press \`Esc\` when you are done, or click anywhere outside the card, to go back to just having it selected.`,
  },
  'amtut.card.t9': {
    zh: `## ④ 动手区 —— 随便改

- [ ] 双击这张卡进入编辑，把这一项勾掉
- [ ] 点开这个双链试试：[[{note}]]
- [ ] 在这一行下面的空行按 \`/\`，插入一个表格

改乱了想从头再来：删掉这个文件，再从命令面板（\`⌘/Ctrl + K\`）搜「使用教程」。`,
    en: `## ④ Playground — change whatever you like

- [ ] Double-click this card to edit it, then tick this item off
- [ ] Try opening this wikilink: [[{note}]]
- [ ] Press \`/\` on the empty line below this one and insert a table

Made a mess and want to start over? Delete this file, then search the command palette (\`⌘/Ctrl + K\`) for "tutorial".`,
  },
  'amtut.toast.noVault': {
    zh: '请先打开一个笔记库(Vault),教程会生成到里面',
    en: 'Open a vault first — the tutorial is created inside it',
  },
  'amtut.toast.failed': {
    zh: '教程生成失败:{err}',
    en: 'Could not create the tutorial: {err}',
  },
})

/** 一课一张卡。`p` = 父卡锚(层级进 tree);x/y = 画布坐标(左上角),文档模式用不着但要占位。
 *  ⚠️ `k` 是 i18n 键不是课文:课文在 tutorialSource() 里现取,模块级存字面量会把语言冻在 import 那一刻。 */
const CARDS: Array<{ id: string; p?: string; x: number; y: number; k: string }> = [
  { id: 't1', x: 820, y: 0, k: 'amtut.card.t1' },
  { id: 't2', p: 't1', x: 1340, y: 0, k: 'amtut.card.t2' },
  { id: 't3', p: 't1', x: 1340, y: 320, k: 'amtut.card.t3' },
  { id: 't4', x: 820, y: 700, k: 'amtut.card.t4' },
  { id: 't5', p: 't4', x: 1340, y: 660, k: 'amtut.card.t5' },
  { id: 't6', p: 't4', x: 1340, y: 980, k: 'amtut.card.t6' },
  { id: 't7', x: 820, y: 1380, k: 'amtut.card.t7' },
  { id: 't8', p: 't7', x: 1340, y: 1360, k: 'amtut.card.t8' },
  { id: 't9', x: 820, y: 1700, k: 'amtut.card.t9' },
]

/** 教程笔记的源码。卡片 = 开锚 + 内容 + 闭合符;几何与层级进 amadeus_canvas 单键。
 *  课文按**调用那一刻**的界面语言取(见文件顶注),`{note}` 只喂 TUTORIAL_PATH 推出的双链落点 ——
 *  中英两份都必须指向磁盘上那一个文件名,所以它不参与翻译。 */
export function tutorialSource(): string {
  const md = (key: string): string => translate(key, { note: TUTORIAL_LINK })
  const body = [
    md('amtut.intro'),
    ...CARDS.map((c) => `<!-- a ${c.id} -->\n\n${md(c.k)}\n\n<!-- /a ${c.id} -->`),
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
    toast(translate('amtut.toast.noVault'))
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
    toast(translate('amtut.toast.failed', { err: e instanceof Error ? e.message : String(e) }), true)
    return
  }
  await openNote(TUTORIAL_PATH)
}
