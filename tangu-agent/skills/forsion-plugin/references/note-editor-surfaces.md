# Note surfaces: block surface and editor extensions

Moved out of SKILL.md (2026-11-02) to keep the skill body inside the model-visible window. Content unchanged.

## 块表面:当前这篇笔记的读写(2026-07-26 起;2026-08-20 改口径)

> **⚠️ 先看 `page.model`。** 普通笔记如今默认是 **v4/unified** 载体,**没有块 id** —— `blocks`/`order`
> 在它上面恒空,正文在 `page.text` 里。块寻址类调用在 v4 笔记上**诚实拒绝并 warn**(不静默),
> 改内容一律用两条路由都成立的 `insertMarkdown`:
>
> ```js
> const pg = ctx.app.getPage()
> const text = pg.text ?? (pg.order || []).map((id) => pg.blocks[id]).join('\n\n')  // 新老宿主通吃
> if (pg.model === 'blocks') { /* v3:可以按块 id 寻址 */ }
> ctx.app.insertMarkdown?.(pg.token, '> 一段引用', 'start')   // 'cursor'(缺省)/'start'/'end'
> ```
>
> **`mountBlocks` 完整可用的地方是插件自定义文件类型**(`.mindmap.md` / `.canvas.md`,经 `file.surface`)
> —— 那类文件按设计钉在 v3,思维导图那套一个字都不用改。下面这段讲的就是它。

**能力对等原则**:内置插件和外置插件拿到的 `ctx` 一模一样,唯一区别是内置的**已经装好了**。此前不是这样 —— 内置插件跑在进程内、能直接给 React 组件,所以只有它们能渲染真块;外置插件是裸 `setup(ctx)` 体,只有 DOM。补上 `ctx.app` 的块表面之后这条缺口关掉了。

想做「一个节点/一张卡片里就是一个可编辑的 Amadeus 块」这类界面(思维导图、看板、白板便签),别自己复刻编辑器 —— **把 DOM 交给宿主渲染**:

```js
const page = ctx.app.getPage()   // {token, path, status, text, model:'blocks'|'text', blocks, order, fmExtra}
const dispose = ctx.app.mountBlocks(el, {
  token: page.token,
  blockId,
  // 传了 onInsertAfter = 宣告「块结构归我管」:笔记式结构键(块首退格并块 / 方向键跨块 / 上下移块)
  // 被中和,而「会新建下一个块」的动作(/数据库 脚手架、非空块里 Shift+Enter)重路由到这里。
  onInsertAfter: (id, content) => addChildNode(id, content),
})
```

**改数据一律要带 `page.token`**:块 id 是**页内**递增的(两页都有 `b1`)。插件拿着 A 页的 id、用户已切到 B 页时继续提交,轻则把块插进 B、重则删掉 B 的同名块 —— 令牌不匹配宿主直接拒绝并 warn。每次 `await` 之后重新 `getPage()` 取新令牌。

| | 用途 | v4 笔记 |
|---|---|---|
| `getPage()` | 当前这篇的快照(**冻结且全插件共用,别改它**) | ✅ |
| `getPage().text` | 整篇正文 markdown(v3 = 块按 order 拼) | ✅ |
| `getPage().model` | `'blocks'`(v3)/ `'text'`(v4)。**分叉判据**;老宿主没这字段 → 当 `'blocks'` | ✅ |
| `subscribePage(cb)` | 正文/块/顺序/外来 frontmatter 变了才回调,返回退订函数 | ✅ |
| `insertMarkdown(token, md, where?)` | 插一段 md,`where` = `'cursor'`(缺省)/`'start'`/`'end'` | ✅ |
| `insertBlockAfter(token, afterId, content)` | 建块,返回新 id(`afterId=null` = 插到最前) | ❌ 返 `null` |
| `deleteBlock(token, id)` | 删块(async) | ❌ |
| `setFmExtra(token, text)` | 写**外来 frontmatter**——你的每页数据存这儿,进页面撤销栈 | ❌ 读可以,写还没开 |
| `undo(token)` / `redo(token)` | 走页面自己的撤销栈(结构改动天然可撤销) | ❌ |
| `requestFocus(id, place)` / `consumeFocus(id)` | 把光标送进某个块(只读焦点,不要令牌) | ❌ |
| `mountBlocks(el, {token, blockId, …})` | 宿主往你的 DOM 里渲染真块 | ❌ 插件文件类型面照常 ✅ |
| `prompt(title, initial)` | 模态输入。**Electron 没有 `window.prompt`,永远别用 DOM 那个** | ✅ |

坑,按踩到的顺序:

- **`page.text` 只读,而且在 v4 上是「上次保存那一刻」的快照**(≤800ms 陈旧)。**绝不「读全文 → 改 → 整篇写回」**:那 800ms 里用户敲的字会被你抹掉。改内容只有 `insertMarkdown`;插进去的文本必须能原样 markdown 往返(连续空格被压 → 宿主重载整篇 → 你的插件状态全没)。
- **不给 v4 合成块 id 是刻意的**:PM 顶层节点没有身份,按位置编号的 id 用户按一次回车就全体位移,而令牌只挡「换了一篇」挡不住「同一篇里 id 易主」。宁可空,不可假。
- **只服务活动页**。Amadeus 是「单活页」模型(同一时刻只加载一处,笔记编辑器和文件类型视图共用),插件跟着走。令牌闸是宿主兜的底,你自己也别拿旧快照连环操作。
- **`fmExtra` 要外科式改**:用户和别的插件的键也在同一份 frontmatter 里,整段重写会抹掉它们。**绝不把数据塞进 `amadeus_layout`**(zod 无 passthrough,未知键加载即被 strip)。
- **`blocks` 的引用是稳定的**:`subscribePage` 靠引用比较去重,自己缓存派生结果时也按引用判,别每帧深比较。快照本身是 `Object.freeze` 的(全插件共用一份,改它没用也不许改)。
- **块 id 会被复用**:落盘前剪掉指向已不存在的块的记录,否则新块会继承旧记录的状态。
- **自己的浮层要小心 `transform`**:`.slash-menu` / 行内工具栏这些是 `position: fixed` + 视口坐标;你的画布若带 pan/zoom 的 `transform`,它就成了 fixed 的包含块,浮层会被平移+缩放一次。把浮层传送到最近的 `.am-app` 下。
- **忘记清理宿主也会兜**:插件被禁用/重载/`setup` 抛错时,你开的 `subscribePage` 与 `mountBlocks` 由宿主统一收掉,之后整份 `ctx.app` 块表面变哑(在飞的异步任务改不动用户文件)。但这是安全网不是设计:该 dispose 还是要 dispose。`mountBlocks` 返回的 dispose 调用之后 `el` 立刻归还(见「dispose 契约」);dispose 再挂是一个新的编辑器,用户正在输入时别这么做(焦点和选区会丢)。
- **内置类型优先是硬规则**:`registerFileType` 的后缀若已被内置认领(`.excalidraw.md`/`.db`/`.pdf`/图片),又没有按下一条显式覆盖,宿主**拒绝注册并返回 `false`** —— 拿到 `false` 就整体退让,连创建器/斜杠项/命令一起别注册(那几个宿主拦不住,不退让用户会看到两份「新建 X」)。旧宿主返回 `undefined`,所以判定写 `=== false`。
- **接管内置的 PDF(2026-10-05 起)**:`.pdf` 是唯一可覆盖的内置后缀。`registerFileType({ id, extensions: ['.pdf'], override: true, mount })` 注册成功后,文件树点击、`ctx.app.openFile`、最近使用都进你的视图;内置阅读器退为兜底 —— 插件停用 / 卸载即回到内置,文件树右键始终有「用内置阅读器打开」。由谁打开归用户定:设置 → 插件 → 已安装 →「默认打开方式」(自动 / 内置阅读器 / 指定插件);「自动」= 归第一个启用中的接管插件,所以别假设注册成功就一定轮到你。不写 `override: true` 照旧返回 `false`;`.excalidraw.md` / `.db` / 图片写了也不行。旧宿主不认这个字段、返回 `false`,照上一条整体退让。要点:
  - **带落点的打开也归你(2.13.2 之后的桌面版本)**:笔记里的 `[[x.pdf#page=3]]`、聊天里的引用(带页码,常常还带一段引语)同样进你的视图,落点经 `mount(el, file)` 的 `file.onGoto?.(cb)` 交给你:`cb({ page, quote? })`,`page` 从 1 起,`quote` 是要在那一页标出来的原文。订阅之后,如果这次打开本身带落点,回调会马上来一次(异步,不在 `onGoto()` 调用里面);视图已经开着时再点别的链接,回调再来,视图不重挂。返回值是退订函数,视图关掉时宿主也会替你收掉。**回调到的时候你多半还没准备好**:文件可能还在加载,或者你的标签刚从后台切回来、还没按新尺寸排过版(这时滚动不生效)—— 把落点记下,等能滚了再跳。不订阅也不报错,只是文件开在你自己的默认位置。2.13.2 及更早没有 `onGoto`:这类跳转(以及笔记里不带页码的 `[[x.pdf]]`)进的是内置阅读器,所以一律 `file.onGoto?.(…)` 探测着用。
  - **换标签、新标签页、对话引用都是宿主管(2.13.3 之后的桌面版本;所有文件类型视图和主区插件视图一样)**:你的标签被换到后台时,宿主把视图的 DOM 从文档里摘下来(不调 unmount,状态都在),换回来原样挂回 —— 摘下期间量到的尺寸和滚动位置都是 0,别在这时候记「看到哪儿」,也别拿这时候的 0 去排版。换回来时宿主把视图里每个滚动容器的位置写回去(更早的版本一律回到顶上),不用自己存;你要是自己也在恢复位置,两边写的是同一个值,不冲突。⌘ / Ctrl + 点击文件树、双链、聊天引用这些入口 = 在新标签页打开你的视图(更早的版本里指向文件的双链会就地顶掉当前标签)。视图在主区显示时,侧栏对话自动把这份文件挂成引用(发给模型的是绝对路径),不用你做什么。
  - **不接管的**:`![[x.pdf]]` 嵌入仍由内置阅读器画(`registerEmbedRenderer` 对 `.pdf` 不会被问到);文件树右键「用内置阅读器打开」是用户点名要内置。
  - **库外 PDF（2026-10-29，功能分支）**：另写 `external: true` 才接系统「用 Forsion 打开」的外部 PDF；默认打开器偏好照旧。`file.io` 只在库外挂载时出现：`readBytes(path)` 读当前 PDF / 隐藏旁挂批注，`writeBytes(path, bytes)` 只写 `.<文件名>.annot.json` 或 `.broken-<时间戳>` 恢复副本，`saveCopy(name, bytes)` 经原生另存为保存带批注副本（取消 null、拒绝覆写原 PDF）。不要把外部绝对路径交给库内的 `ctx.app`。mount 清理可返回 Promise，关标签等保存后吊销、停用仍立即吊销；共享文档别留住已关闭标签的 io。旧宿主缺接口时不接库外文件。
  - **读写走字节**:`ctx.app.readBytes?.(file.filePath)` 读、`ctx.app.writeBytes?.(…)` 存。`file.surface.loadPage` 和 `ctx.app.loadPage` 都只收 `.md` 笔记,对 PDF(以及白板)调用会被拒并打告警(那是笔记管线,放行就把文件写成 markdown);`ctx.app.openNote` 收到非笔记路径会改走 `openFile` 开对的视图。
  - **manifest 不要写 `fileExtensions: ['.pdf']`**:那个字段只保护 `.md` 类文件不被当笔记改写,PDF 用不着;写了反而让开发副本被判 `dev-fileext` 拒载。不写的话可以直接从 Sandbox 加载着测(开发副本只是不能注册 `.md` 类后缀)。
  - **内置阅读器只读(2026-10-05 起不再批注)**,文件一变就原地重载:你 `writeBytes` 之后,已经开着的内置标签页和 `![[x.pdf]]` 嵌入会跟上,不用你通知。`ctx.app.watchFile?.()` 对 `.pdf` 也会回调(外部工具改了文件、另一个插件写了它),但事件不比内容 —— 你自己写的那次也会来,回调里先比一下字节再决定要不要重载。
- **四条新建主路径都要注册**:文件树右键(`registerFileCreator`)、命令面板(`registerCommand`)、笔记里的 `/`(`registerSlashItem` + `run()`,建完就地嵌入)、**新建标签页启动器**(2026-07-26 起也列 `registerFileCreator`,与内置的「新建白板」并排)。少注册一条,用户就会问「为什么 XX 里没有它」。
- **想做「节点/卡片里是真块」的界面,照 `forsion-plugin-mindmap` 3.0.0 抄**:它是块表面 seam 的样板 —— 一层薄适配(`src/host.tsx`)把 `ctx.app` 伪装成宿主 store/组件的形状,画布本体几乎原样;令牌只在适配层管一次。⚠️那层里按内容去重的缓存**不是优化是正确性**:`getPage()` 每次返回新对象,不去重则 `useSyncExternalStore` 每次判「变了」→ 无限重渲挂死。React 也内联进包(插件拿不到宿主模块图;两份 React 共存没问题,边界就是 `mountBlocks` 那个 DOM 节点)。

## 伸进编辑器 + 自绘设置面板(2026-08-15 起)

「能力对等」的第二批兑现。此前只有宿主内置能碰笔记编辑器的按键与装饰,插件的设置也只能是一排
number/boolean/text 旋钮 —— 这两条卡死了一整类插件(输入法式片段展开、语法高亮、规则表编辑器)。
参考实现:`Forsion-Instrumentality-Project/forsion-plugin-latex-suite`(四条接缝全用上了)。

```js
// ① 往笔记编辑器里注 ProseMirror 插件。外置插件**没有 import**,所以宿主把自己那份 PM 递进来。
ctx.registerEditorExtension?.((pm) => [
  new pm.Plugin({
    key: new pm.PluginKey('my-thing'),
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing) return false      // ⚠️中文输入法组合中途绝不介入
        return false                           // 不处理就 false,把输入还给宿主
      },
    },
  }),
], { priority: 'high' })   // 'high' = 排在宿主全部插件之前(要抢 Tab 这类已占用的键才用)

// ② 自绘设置面板:宿主给裸容器,里面画什么全归你
ctx.registerSettingsView?.({ id: 'main', title: '高级', mount(el) { /* … */ return () => {} } })

// ③ 每插件一份 JSON blob(<Forsion 家目录>/plugins-data/<id>.json,dev 与安装版各一份,原子写)
const data = (await ctx.loadData?.()) ?? { rules: [] }
await ctx.saveData?.(data)

// ④ 库内文件的外部改动订阅(热重载用户手写的配置文件)
const off = ctx.app.watchFile?.('Snippets/latex.js', () => reload())
```

坑,按会栽的顺序:

- **`priority: 'high'` 是有义务的**:它坐在每一次按键最前面,**不该自己处理的必须 `return false`** ——
  少一个 false,宿主的列表缩进/回车分块在用户那里就静默消失了。只为「要接管宿主已占用的键」用它,
  纯装饰(高亮、隐藏、气泡)一律缺省 `'normal'`。
- **`pm` 里有什么就用什么**:`Plugin PluginKey Selection TextSelection NodeSelection Decoration
  DecorationSet Slice Fragment keymap InputRule inputRules`。`import type` 拿类型可以(会被擦掉),
  **运行时不许 import prosemirror** —— 打进包里就是第二份 PM,`instanceof` 与 PluginKey 全对不上。
- **factory 每个编辑器实例调一次**:一篇 v3 笔记是很多个小编辑器,别把「每编辑器状态」挂在工厂外的共享对象上。
- **零 schema / 零序列化**:只能产生纯文本改动 + 装饰 + 按键拦截。想改落盘格式的不走这条路。
- **`props.*` 宿主包了 try/catch,`state.apply` 没包** —— 后者吞异常等于放任状态损坏。状态迁移自己写稳。
- **设置类页面先用 `ctx.ui.mountSettingsPage`**(2026-10-17 起,见 references/host-ui-mounts.md):开关、按钮、输入、额度条都有宿主零件,手机排法由宿主管;
  只有清单外的内容才自己画(放进 `custom` 块)。
- **设置面板会被反复挂载卸载**(用户来回进出详情页):状态别放模块级单例,dispose 要真收干净
  (定时器、DOM 监听、内嵌的 CodeMirror 实例)。容器上有宿主主题变量但**没有样式重置**,自己带样式、深浅色都要过。
- **大块数据用 `loadData/saveData`,别塞 localStorage**:`registerSetting` 是每键一个字符串,没有原子性。
  用户手改坏了 JSON,宿主返回 `null` 当没写过 —— 插件要能靠默认值起来。
- **想让这份数据跟着账号走,manifest 写 `"syncData": true`**(2026-10-17 起,桌面 / 手机;网页版不同步):
  登录后 `saveData` 先写本机、后台推上云端,换设备时 `loadData` 先拉到较新的那份再返回(最多等 3 秒,
  没登录 / 断网照旧只用本机)。**整份取较新的,不做字段合并** —— 两台设备都改过,**编辑**得较晚的那次赢(离线改、晚上传的照样按编辑时刻比),
  另一份服务端留一版。单份 ≤512 KB、每个账号 ≤100 个插件。用户可以在插件详情页逐台设备关掉。
  内容服务端只存不读,不进任何模型上下文;但**别往里放密钥 / 令牌**(它会出现在用户的每台设备上)。
  `loadData` 只在调用时对一次账,**运行中别的设备改了不会推给你** —— 要实时互通的数据别走这条。
  用户卸载时没勾「保留设置」,云端那份一起清掉(本机那份进回收站);恢复后本机这份重传,别的设备还装着时也会把它的传回来。
- **`watchFile` 缺位时整条方法不挂**(不是空壳):`if (ctx.app.watchFile) … else 轮询` 才走得对。
  它只报「内容变了」,新建/删除/改名不报;自己 `writeFile` 落的盘不会回声。
