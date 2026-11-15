// 和 Obsidian 的手感对照:场景表。同一份起始 Markdown + 同一串按键,Obsidian 1.15.1(实况预览)那一侧的结果录在
// baseline.json 里,obsidian-feel.check.cjs 只在 Forsion v4 统一编辑器(台架 ?upage)上重放,再和基线比。说明见 README.md。
// 计时类场景(P 开头,dim = 'perf')留在表里,不进这条检查。
// 步骤:
//   { caret: { after|before: '可见文字', nth? } | { end: true } | { start: true } }   用接口放光标(不混进点击落点的变量)
//   { select: { text } | { from, to } }      选中一段可见文字
//   { press: 'Enter', times?, trace?, traceMd? }  真按键;Mod = mac 上的 ⌘。trace:每按一次记一次光标上下文(两边坐标系不同,检查不比);traceMd:每按一次记一次 Markdown(去掉文末换行)
//   { type: '文字', delay? }                 逐字符真按键输入
//   { ime: { steps: ['n','ni'], commit: '你' } }   用 CDP 模拟一次输入法组字
//   { copy: true } / { cut: true } / { paste: { 'text/plain': …, 'text/html': … } }   合成剪贴板事件,不动系统剪贴板
//   { dblclick|click|tripleclick: { text } } 真鼠标,点在那段可见文字的中间
//   { clickXY: { text, dx?, dy? } }           真鼠标,点在那段文字中心偏移 (dx, dy) 的位置
//   { external: '新内容' }                   别的程序改了这个文件(Obsidian:直接写盘;Forsion 台架:触发文件变更通知)
//   { wait: 毫秒 }
//   { snap: '名字', shot?: false }           记一次 Markdown(这条检查只比 Markdown;shot 字段是录基线时的截图开关,这里不用)
// 锚点文字必须在两边的可见文字里都存在(别用 ** 这类标记字符当锚点)。
const S = []
const add = (id, dim, title, md, steps) => S.push({ id, dim, title, md, steps })
// 「空行上开始」的写法:起始文档最后一段只有一个 q,选中它退格 —— 两边都得到一个空行 / 空段,不用靠回车造(回车在两边含义不同,见 K25)。
const BLANK = [{ select: { text: 'q' } }, { press: 'Backspace' }]

// ── K 块级键盘 ─────────────────────────────────────────────
add('K01', 'keys', '无序列表:回车续项,空项回车脱出', '- one', [
  { caret: { end: true } }, { press: 'Enter' }, { type: 'two' }, { snap: '续项后' },
  { press: 'Enter' }, { snap: '空项' }, { press: 'Enter' }, { snap: '空项再回车' }, { type: 'x' }, { snap: '接着打字' },
])
add('K02', 'keys', '嵌套列表:空子项回车', '- a\n    - b', [
  { caret: { end: true } }, { press: 'Enter' }, { snap: '新子项' }, { press: 'Enter' }, { snap: '空子项回车一次' },
  { press: 'Enter' }, { snap: '回车两次' }, { press: 'Enter' }, { snap: '回车三次' },
])
add('K03', 'keys', '有序列表:中间插入一项后的编号', '1. a\n2. b\n3. c', [
  { caret: { after: 'a' } }, { press: 'Enter' }, { type: 'x' }, { snap: '插入后' },
])
add('K04', 'keys', '待办:已勾选项末尾回车', '- [x] done', [
  { caret: { end: true } }, { press: 'Enter' }, { type: 'next' }, { snap: '新项' },
])
add('K05', 'keys', '标题中间回车', '# Hello world', [
  { caret: { after: 'Hello' } }, { press: 'Enter' }, { snap: '拆开后' },
])
add('K06', 'keys', '标题文字开头连按退格', '## Title\n\nbody', [
  { caret: { before: 'Title' } }, { press: 'Backspace' }, { snap: '退格1' }, { press: 'Backspace' }, { snap: '退格2' },
  { press: 'Backspace' }, { snap: '退格3' },
])
add('K07', 'keys', '引用:回车续行,空行回车脱出', '> quote', [
  { caret: { end: true } }, { press: 'Enter' }, { type: 'more' }, { snap: '续行' },
  { press: 'Enter' }, { snap: '空行' }, { press: 'Enter' }, { snap: '空行再回车' },
])
add('K08', 'keys', '普通段落开头按 Tab', 'para', [
  { caret: { before: 'para' } }, { press: 'Tab' }, { snap: 'Tab后' }, { press: 'Shift+Tab' }, { snap: 'ShiftTab后' },
])
add('K09', 'keys', '列表项 Tab / Shift+Tab', '- a\n- b', [
  { caret: { after: 'b' } }, { press: 'Tab' }, { snap: '缩进' }, { press: 'Shift+Tab' }, { snap: '反缩进' },
])
add('K10', 'keys', '列表项文字开头连按退格', '- a\n- b', [
  { caret: { before: 'b' } }, { press: 'Backspace' }, { snap: '退格1' }, { press: 'Backspace' }, { snap: '退格2' },
  { press: 'Backspace' }, { snap: '退格3' },
])
add('K11', 'keys', '自动成对:圆括号,敲右括号跳过,成对退格', 'ab', [
  { caret: { end: true } }, { type: ' (' }, { snap: '左括号' }, { type: 'a' }, { type: ')' }, { snap: '右括号' },
  { type: ' (' }, { press: 'Backspace' }, { snap: '成对退格' },
])
const pairCase = (id, name, ch) => add(id, 'keys', `自动成对:${name}`, 'ab', [
  { caret: { end: true } }, { type: ' ' + ch }, { snap: '敲下后' }, { type: 'x' }, { snap: '接着打字' },
])
pairCase('K12a', '星号', '*')
pairCase('K12b', '反引号', '`')
pairCase('K12c', '美元', '$')
pairCase('K12d', '双方括号', '[[')
pairCase('K12e', '英文双引号', '"')
pairCase('K12f', '两个等号', '==')
pairCase('K12g', '下划线', '_')
pairCase('K12h', '方括号与花括号', '[{')
add('K13', 'keys', '选中文字后敲符号包裹', 'hello world', [
  { select: { text: 'world' } }, { type: '*' }, { snap: '星号包裹' },
])
add('K13b', 'keys', '选中文字后敲反引号 / 方括号 / 美元', 'hello world there', [
  { select: { text: 'world' } }, { type: '`' }, { snap: '反引号包裹' },
  { select: { text: 'there' } }, { type: '[' }, { snap: '方括号包裹' },
  { select: { text: 'hello' } }, { type: '$' }, { snap: '美元包裹' },
])
add('K13c', 'keys', '选中文字后敲圆括号 / 引号 / 等号', 'hello world there', [
  { select: { text: 'world' } }, { type: '(' }, { snap: '圆括号包裹' },
  { select: { text: 'there' } }, { type: '"' }, { snap: '引号包裹' },
  { select: { text: 'hello' } }, { type: '=' }, { snap: '等号包裹' },
])
add('K14', 'keys', '输入「# 空格」后再退格', 'start\n\nq', [
  ...BLANK, { type: '# ' }, { snap: '井号空格' }, { type: 'T' }, { snap: '标题字' },
  { press: 'Backspace' }, { snap: '退格1' }, { press: 'Backspace' }, { snap: '退格2' }, { press: 'Backspace' }, { snap: '退格3' },
])
add('K15a', 'keys', '输入「- 空格」开列表', 'start\n\nq', [...BLANK, { type: '- ' }, { snap: '横杠空格' }, { type: 'a' }, { snap: '打字后' }])
add('K15b', 'keys', '输入「* 空格」「+ 空格」开列表', 'start\n\nq\n\nw', [
  ...BLANK, { type: '* ' }, { type: 'a' }, { snap: '星号列表' }, { select: { text: 'w' } }, { press: 'Backspace' }, { type: '+ ' }, { type: 'b' }, { snap: '加号列表' },
])
add('K15c', 'keys', '输入「1. 空格」「1) 空格」', 'start\n\nq\n\nw', [
  ...BLANK, { type: '1. ' }, { type: 'a' }, { snap: '数字点' }, { select: { text: 'w' } }, { press: 'Backspace' }, { type: '1) ' }, { type: 'b' }, { snap: '数字括号' },
])
add('K15d', 'keys', '输入「> 空格」', 'start\n\nq', [...BLANK, { type: '> ' }, { snap: '大于号空格' }, { type: 'c' }, { snap: '打字后' }])
add('K15e', 'keys', '输入「- [ ] 空格」', 'start\n\nq', [...BLANK, { type: '- [ ] ' }, { snap: '待办标记' }, { type: 'd' }, { snap: '打字后' }])
add('K16', 'keys', '输入代码围栏,再用方向键走出去', 'start\n\nq', [
  ...BLANK, { type: '```js' }, { snap: '围栏首行' }, { press: 'Enter' },
  { type: 'let a = 1' }, { snap: '围栏内' }, { press: 'ArrowDown' }, { press: 'ArrowDown' }, { type: 'after' }, { snap: '下方向键两次后打字' },
])
add('K17', 'keys', '输入分割线', 'start\n\nq', [
  ...BLANK, { type: '---' }, { snap: '三横杠' }, { press: 'Enter' }, { type: 'after' }, { snap: '回车后' },
])
add('K18', 'keys', 'Shift+Enter', 'ab\n\n- cd', [
  { caret: { after: 'a' } }, { press: 'Shift+Enter' }, { snap: '段内' }, { caret: { after: 'c' } }, { press: 'Shift+Enter' }, { snap: '列表内' },
])
add('K19', 'keys', '待办上 Mod+Enter 与 Mod+L', '- [ ] todo\n\nplain', [
  { caret: { after: 'todo' } }, { press: 'Mod+Enter' }, { snap: 'ModEnter' }, { press: 'Mod+l' }, { snap: 'ModL' },
  { caret: { after: 'plain' } }, { press: 'Mod+l' }, { snap: '段落ModL一次' }, { press: 'Mod+l' }, { snap: '段落ModL两次' },
])
add('K20', 'keys', 'Mod+B:有选区 / 无选区', 'hello world', [
  { select: { text: 'world' } }, { press: 'Mod+b' }, { snap: '选区加粗' },
  { caret: { end: true } }, { type: ' ' }, { press: 'Mod+b' }, { snap: '空选区按下' }, { type: 'x' }, { snap: '接着打字' },
])
add('K21', 'keys', 'Mod+D、Mod+/、Mod+E', 'aaa\n\nbbb\n\nccc', [
  { caret: { after: 'bb' } }, { press: 'Mod+/' }, { snap: 'Mod斜杠' }, { press: 'Mod+/' },
  { press: 'Mod+d' }, { snap: 'ModD' }, { caret: { after: 'aa' } }, { press: 'Mod+e' }, { snap: 'ModE', full: true },
])
add('K22', 'keys', '表格里 Tab / Enter', '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter', [
  { caret: { after: '1' } }, { press: 'Tab' }, { type: 'x' }, { snap: 'Tab到下一格' }, { press: 'Tab' }, { snap: '末格Tab' },
  { press: 'Enter' }, { snap: '格内回车' },
])
add('K23', 'keys', '段首退格并入上一段;段尾 Delete', 'one\n\ntwo\n\n- three', [
  { caret: { before: 'two' } }, { press: 'Backspace' }, { snap: '段首退格' }, { caret: { after: 'two' } }, { press: 'Delete' }, { snap: '段尾Delete' },
])
add('K24', 'keys', '代码块里 Tab 与回车缩进', '```js\nif (a) {\n```', [
  { caret: { after: '{' } }, { press: 'Enter' }, { type: 'x' }, { snap: '回车后' }, { press: 'Tab' }, { snap: 'Tab后' },
])

add('K25', 'keys', '普通段落:回车一次 / 两次', 'one', [
  { caret: { end: true } }, { press: 'Enter' }, { type: 'two' }, { snap: '回车一次' }, { press: 'Enter' }, { press: 'Enter' }, { type: 'three' }, { snap: '回车两次' },
  { press: 'Backspace', times: 7, traceMd: true }, { snap: '退格七次后', shot: false },
])
add('K26', 'keys', '空待办项连按退格', '- [ ] a', [
  { caret: { end: true } }, { press: 'Backspace', times: 7, traceMd: true }, { snap: '退格七次后' },
])
add('K27', 'keys', '标题末尾回车;空标题回车', '## Title', [
  { caret: { end: true } }, { press: 'Enter' }, { type: 'x' }, { snap: '标题末回车' },
])
add('K28', 'keys', '有序列表项 Tab 缩进后的编号', '1. a\n2. b\n3. c', [
  { caret: { after: 'b' } }, { press: 'Tab' }, { snap: '缩进后' }, { press: 'Shift+Tab' }, { snap: '反缩进后' },
])
add('K29', 'keys', '带子项的列表项 Tab', '- a\n- b\n    - c', [
  { caret: { after: 'b' } }, { press: 'Tab' }, { snap: '缩进后' },
])

add('K30', 'keys', '引用正文开头退格', 'before\n\n> quote text', [
  { caret: { before: 'quote' } }, { press: 'Backspace' }, { snap: '退格1' }, { press: 'Backspace' }, { snap: '退格2' },
])
add('K31', 'keys', '第一个列表项上 Shift+Tab', '- one\n- two', [
  { caret: { after: 'one' } }, { press: 'Shift+Tab' }, { snap: '反缩进后' },
])
add('K32', 'keys', '有子项的列表项中间回车', '- onetwo\n    - child', [
  { caret: { after: 'one' } }, { press: 'Enter' }, { snap: '拆开后' },
])
add('K33', 'keys', '代码块里回车是否继承缩进', '```js\n  let a = 1\n```', [
  { caret: { after: '= 1' } }, { press: 'Enter' }, { type: 'b' }, { snap: '回车后' },
])

// ── R 语法显隐 ─────────────────────────────────────────────
add('R01', 'reveal', '加粗:光标在外 / 进到里面', 'plain **bold** tail\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'tail' } }, { snap: '同一行不相邻' },
  { caret: { after: 'bol' } }, { snap: '光标在加粗里' }, { caret: { after: 'plain ' } }, { snap: '光标贴着左边界' },
])
add('R02', 'reveal', '标题的 # 标记', '## Heading\n\ntext', [
  { caret: { after: 'text' } }, { snap: '光标在别行' }, { caret: { after: 'Head' } }, { snap: '光标在标题里' },
])
add('R03', 'reveal', '普通链接', 'see [site](https://example.com) now\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'sit' } }, { snap: '光标在链接里' },
])
add('R04', 'reveal', '双链与别名', 'see [[Note|alias]] and [[Other]] now\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'ali' } }, { snap: '光标在别名里' }, { caret: { after: 'Oth' } }, { snap: '光标在双链里' },
])
add('R05', 'reveal', '行内代码 / 删除线 / 高亮 / 斜体', 'a `code` b ~~del~~ c ==hi== d *em* e\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'cod' } }, { snap: '在代码里' },
  { caret: { after: 'de' } }, { snap: '在删除线里' }, { caret: { after: 'h' } }, { snap: '在高亮里' },
])
add('R06', 'reveal', '列表标记与待办方框', '- item\n- [ ] todo\n- [x] done\n\n1. one\n2. two\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'tod' } }, { snap: '光标在待办里' }, { caret: { before: 'todo' } }, { snap: '光标在待办文字开头' },
])
add('R07', 'reveal', '引用与 callout', '> plain quote\n\n> [!note] Title\n> body text\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'Tit' } }, { snap: '光标在 callout 标题' },
  { caret: { after: 'body' } }, { snap: '光标在 callout 正文' }, { caret: { after: 'plain' } }, { snap: '光标在引用里' },
])
add('R08', 'reveal', '代码围栏', '```js\nlet a = 1\n```\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'let' } }, { snap: '光标在代码里' },
])
add('R09', 'reveal', '行内公式与块公式', 'a $x^2+1$ b\n\n$$\n\\frac{a}{b}\n$$\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'x^2' } }, { snap: '光标在行内公式里' }, { caret: { after: 'frac' } }, { snap: '光标在块公式里' },
])
add('R10', 'reveal', '表格', '| name | qty |\n| --- | --- |\n| pen | 2 |\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'pen' } }, { snap: '光标在单元格里' },
])
add('R11', 'reveal', '标签、脚注、注释、HTML', 'text #tag more[^1] x %%hidden%% y <u>under</u> z\n\n[^1]: note\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'ta' } }, { snap: '光标在标签里' }, { caret: { after: 'hidd' } }, { snap: '光标在注释里' },
])
add('R12', 'reveal', '分割线与 frontmatter', '---\ntitle: T\ntags: [a, b]\n---\n\nabove\n\n---\n\nnext', [
  { caret: { after: 'next' } }, { snap: '光标在别行' }, { caret: { after: 'above' } }, { press: 'ArrowDown' }, { press: 'ArrowDown' }, { snap: '方向键走到分割线' },
])

add('R13', 'reveal', '在加粗右边界外退格', 'a **bold** z', [
  { caret: { before: ' z' } }, { snap: '光标贴着右边界' }, { press: 'Backspace' }, { snap: '退格一次' },
])
add('R14', 'reveal', '打完双链的 ]] 之后', 'see x', [
  { caret: { after: 'see ' } }, { type: '[[Note]]' }, { snap: '刚打完' }, { type: ' ' }, { snap: '再打一个空格' },
])
add('R15', 'reveal', '左方向键从右边走进链接', 'go [site](https://example.com) end', [
  { caret: { before: 'end' } }, { press: 'ArrowLeft' }, { snap: '左一次' }, { press: 'ArrowLeft' }, { snap: '左两次' }, { press: 'ArrowLeft' }, { snap: '左三次' },
])
add('R16', 'reveal', '下方向键走进 callout', 'para\n\n> [!note] Title\n> body\n\nend', [
  { caret: { after: 'para' } }, { press: 'ArrowDown' }, { press: 'ArrowDown' }, { snap: '走到标题行' }, { press: 'ArrowDown' }, { snap: '走到正文行' },
])
add('R17', 'reveal', '星号列表:左方向键走到标记', '* one\n* two', [
  { caret: { before: 'two' } }, { press: 'ArrowLeft' }, { snap: '左一次' }, { press: 'ArrowLeft' }, { snap: '左两次' },
])
add('R18', 'reveal', '上方向键从下面走进表格', 'para\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend', [
  { caret: { before: 'end' } }, { press: 'ArrowUp' }, { type: 'X' }, { snap: '上一次后打字' },
])

// ── C 光标、选区、剪贴板 ───────────────────────────────────
add('C01', 'caret', '右方向键穿过加粗', 'ab **cd** ef', [
  { caret: { after: 'ab' } }, { press: 'ArrowRight', times: 8, trace: true }, { snap: '走完', shot: false },
])
add('C02', 'caret', '右方向键穿过链接与双链', 'a [l](https://e.com) b [[N]] c', [
  { caret: { after: 'a' } }, { press: 'ArrowRight', times: 12, trace: true }, { snap: '走完', shot: false },
])
add('C03', 'caret', '右方向键穿过行内公式', 'a $x$ b', [
  { caret: { after: 'a' } }, { press: 'ArrowRight', times: 7, trace: true }, { snap: '走完', shot: false },
])
add('C04', 'caret', '下方向键穿过块公式、代码块、表格', 'top\n\n$$\nx+y\n$$\n\n```\ncode\n```\n\n| a |\n| --- |\n| 1 |\n\nbottom', [
  { caret: { after: 'top' } }, { press: 'ArrowDown', times: 14, trace: true }, { snap: '走完', shot: false },
])
add('C05', 'caret', 'Home / End 在标题与列表行', '## Heading here\n\n- item text', [
  { caret: { after: 'Head' } }, { press: 'Home' }, { snap: '标题Home', shot: false }, { press: 'End' }, { snap: '标题End', shot: false },
  { caret: { after: 'item' } }, { press: 'Home' }, { snap: '列表Home', shot: false }, { press: 'Mod+ArrowLeft' }, { snap: '列表Mod左', shot: false },
])
add('C06', 'caret', 'Mod+A 连按', 'para one\n\npara two\n\n- li', [
  { caret: { after: 'one' } }, { press: 'Mod+a' }, { snap: '第一次' }, { press: 'Mod+a' }, { snap: '第二次' }, { press: 'Mod+a' }, { snap: '第三次' },
])
add('C07', 'caret', '复制:选中加粗文字 / 空选区', 'plain **bold** tail\n\n- [ ] todo $x$ [[N]]', [
  { select: { text: 'bold' } }, { copy: true }, { snap: '选中加粗复制', shot: false },
  { caret: { after: 'tail' } }, { copy: true }, { snap: '空选区复制', shot: false },
  { select: { from: 'plain', to: 'todo' } }, { copy: true }, { snap: '跨块复制', shot: false },
])
add('C08', 'caret', '粘贴:选中文字后粘网址', 'hello world', [
  { select: { text: 'world' } }, { paste: { 'text/plain': 'https://example.com' } }, { snap: '粘贴后' },
])
add('C09', 'caret', '粘贴:Markdown 纯文本', 'start\n\nq', [
  ...BLANK, { paste: { 'text/plain': '**b** and [l](https://e.com)\n- x\n- y' } }, { snap: '粘贴后' },
])
add('C10', 'caret', '粘贴:网页 HTML', 'start\n\nq', [
  ...BLANK,
  { paste: { 'text/plain': 'Hello bold link\none', 'text/html': '<p>Hello <b>bold</b> <a href="https://e.com">link</a></p><ul><li>one</li></ul>' } }, { snap: '粘贴后' },
])
add('C11', 'caret', '粘贴:多行纯文本', 'start\n\nq', [
  ...BLANK, { paste: { 'text/plain': 'line one\nline two\n\nline four' } }, { snap: '粘贴后' },
])
add('C12', 'caret', '双击选词 / 三击', 'hello brave world\n\nsecond para', [
  { dblclick: { text: 'brave' } }, { snap: '双击' }, { tripleclick: { text: 'brave' } }, { snap: '三击' },
])
add('C13', 'caret', 'Shift+方向键跨过加粗与公式扩选', 'ab **cd** $x$ ef', [
  { caret: { after: 'ab' } }, { press: 'Shift+ArrowRight', times: 9, trace: true }, { snap: '扩选后' },
])
add('C14', 'caret', '点击渲染后的链接文字 / 加粗文字', 'see [site](https://example.com) and **bold** end', [
  { caret: { end: true } }, { click: { text: 'bold' } }, { snap: '点加粗' }, { caret: { end: true } }, { click: { text: 'site' } }, { snap: '点链接' },
])
add('C15', 'caret', '按词移动(含中文)', 'hello brave world 你好世界今天天气不错', [
  { caret: { start: true } }, { press: 'Alt+ArrowRight', times: 6, trace: true }, { snap: '走完', shot: false },
])

add('C16', 'caret', '下方向键走进块公式', 'top\n\n$$\nx+y\n$$\n\nbottom', [
  { caret: { after: 'top' } }, { press: 'ArrowDown' }, { snap: '按一次' }, { press: 'ArrowDown' }, { snap: '按两次' }, { press: 'ArrowDown' }, { snap: '按三次' },
])
add('C17', 'caret', '光标贴在链接、行内代码的右边界再打字', 'see [site](https://example.com) and `code` end', [
  { caret: { after: 'site' } }, { type: 'X' }, { snap: '链接末尾打字' }, { caret: { after: 'code' } }, { type: 'Y' }, { snap: '代码末尾打字' },
])
add('C18', 'caret', '加粗文字末尾接着打字', 'a **bold** b', [
  { caret: { after: 'bold' } }, { type: 'X' }, { snap: '加粗末尾打字' }, { press: 'ArrowRight' }, { press: 'ArrowRight' }, { type: 'Y' }, { snap: '右移两次后打字' },
])
add('C19', 'caret', '剪切:空选区', 'line one\n\nline two\n\nline three', [
  { caret: { after: 'line tw' } }, { cut: true }, { snap: '空选区剪切后', shot: false },
])

add('C20', 'caret', '行内公式右边退格', 'ends with $x+y$', [
  { caret: { end: true } }, { press: 'Backspace' }, { snap: '退格一次' }, { press: 'Backspace' }, { snap: '退格两次' },
])
add('C21', 'caret', '在最后一行下方的空白处单击', 'only line', [
  { caret: { start: true } }, { clickXY: { text: 'only', dy: 120 } }, { snap: '点击后' }, { type: 'x' }, { snap: '接着打字' },
])
add('C22', 'caret', '点击行内公式', 'a $x+y$ b\n\nnext', [
  { caret: { after: 'next' } }, { clickXY: { text: 'a ', dx: 28, dy: 0 } }, { snap: '点公式后' },
])

// ── S 撤销、输入法、模式 ───────────────────────────────────
add('S01', 'state', '撤销:连续打字算几步', 'start', [
  { caret: { end: true } }, { type: ' hello world', delay: 40 }, { press: 'Mod+z' }, { snap: '撤销1', shot: false }, { press: 'Mod+z' }, { snap: '撤销2', shot: false },
])
add('S02', 'state', '撤销:停顿 0.8 秒后再打', 'start', [
  { caret: { end: true } }, { type: ' aaa', delay: 40 }, { wait: 800 }, { type: 'bbb', delay: 40 }, { press: 'Mod+z' }, { snap: '撤销1', shot: false },
  { press: 'Mod+z' }, { snap: '撤销2', shot: false }, { press: 'Mod+Shift+z' }, { snap: '重做1', shot: false },
])
add('S03', 'state', '撤销:自动成对与列表续行', '- a', [
  { caret: { end: true } }, { press: 'Enter' }, { type: 'b(' }, { press: 'Mod+z' }, { snap: '撤销1', shot: false }, { press: 'Mod+z' }, { snap: '撤销2', shot: false },
  { press: 'Mod+z' }, { snap: '撤销3', shot: false },
])
add('S04', 'state', '撤销:输入「# 空格」的转换', 'start\n\nq', [
  ...BLANK, { type: '# ' }, { wait: 600 }, { press: 'Mod+z' }, { snap: '撤销1' }, { press: 'Mod+z' }, { snap: '撤销2' },
])
add('S05', 'state', '输入法组字:普通段落', 'start', [
  { caret: { end: true } }, { type: ' ' }, { ime: { steps: ['n', 'ni', 'ni h', 'ni hao'], commit: '你好' } }, { snap: '上屏后' },
  { press: 'Mod+z' }, { snap: '撤销一次', shot: false },
])
add('S06', 'state', '输入法组字:加粗里、行内公式旁', 'a **bold** b $x$ c', [
  { caret: { after: 'bol' } }, { ime: { steps: ['z', 'zh', 'zhong'], commit: '中' } }, { snap: '加粗里上屏' },
  { caret: { after: 'b ' } }, { ime: { steps: ['w', 'wen'], commit: '文' } }, { snap: '公式前上屏' },
])
add('S07', 'state', '输入法组字时列表行首的标记', 'start\n\nq', [
  ...BLANK, { type: '- ' }, { ime: { steps: ['x', 'xiang'], commit: '项' } }, { snap: '上屏后' },
  { press: 'Enter' }, { ime: { steps: ['e', 'er'], commit: '二' } }, { snap: '第二项' },
])
add('S08', 'state', '全角符号触发', 'start\n\nq', [
  ...BLANK, { type: '【【' }, { snap: '全角方括号', full: true },
])
add('S09', 'state', '输入 [[ 弹联想后回车', 'start', [
  { caret: { end: true } }, { type: ' [[' }, { wait: 300 }, { snap: '弹出联想', full: true }, { type: 'Emb' }, { wait: 300 }, { press: 'Enter' }, { snap: '回车选中' },
])
add('S10', 'state', '输入 / 与 #', 'start\n\nq', [
  ...BLANK, { type: '/' }, { wait: 300 }, { snap: '斜杠', full: true }, { press: 'Escape' }, { press: 'Backspace' },
  { type: '#ta' }, { wait: 300 }, { snap: '井号标签', full: true },
])

add('S11', 'state', '撤销:打字后立刻粘贴', 'start', [
  { caret: { end: true } }, { type: ' xy', delay: 40 }, { paste: { 'text/plain': 'PASTE' } }, { press: 'Mod+z' }, { snap: '撤销1', shot: false }, { press: 'Mod+z' }, { snap: '撤销2', shot: false },
])
add('S12', 'state', '外部改了文件(没有未存修改),再撤销', 'Hello', [
  { caret: { end: true } }, { wait: 2600 }, { external: 'Hello\nWorld\n' }, { wait: 2600 }, { snap: '外部改动到达后' }, { press: 'Mod+z' }, { snap: '撤销一次' },
])
add('S13', 'state', '刚打完字,外部同时改了别的行', 'line one\nline two', [
  { caret: { after: 'line one' } }, { type: 'AAA', delay: 30 }, { external: 'line one\nline twoBBB\n' }, { wait: 3500 }, { snap: '三秒半后' },
])
add('S14', 'state', '撤销:回车续出的列表项', '- a', [
  { caret: { end: true } }, { type: 'bc', delay: 40 }, { press: 'Enter' }, { type: 'de', delay: 40 }, { press: 'Mod+z' }, { snap: '撤销1', shot: false }, { press: 'Mod+z' }, { snap: '撤销2', shot: false },
])
add('S15', 'state', '输入法组字:紧贴行内公式右边', 'let $x$ be', [
  { caret: { after: '$x$' } }, { ime: { steps: ['s', 'sh', 'shi'], commit: '是' } }, { snap: '上屏后' },
])

// ── F 保存保真:只在别处打一个 Z,看这一块被改写了多少 ─────────
const fid = (id, title, md, anchor) => add(id, 'fidelity', title, md, [{ caret: { after: anchor } }, { type: 'Z' }, { snap: '打一个Z后', shot: false }])
fid('F01', '强调符 _ 与 __', 'one _em_ __st__ two', 'two')
fid('F02', '星号列表标记', '* a\n* b', 'b')
fid('F03', '加号列表、右括号编号、4 空格嵌套', '+ a\n    + b\n\n1) x\n2) y', 'y')
fid('F04', '松散列表与紧凑列表', '- a\n\n- b\n\n- c', 'c')
fid('F05', '表格的空格与对齐写法', '|a|b|\n|:-|-:|\n|1|2|', '1')
fid('F06', 'Setext 标题', 'Title\n=====\n\ntext', 'Title')
fid('F07', '反斜杠转义', 'a \\* b 1\\. c \\_ d \\# e', 'e')
fid('F08', '行尾两空格硬换行与反斜杠换行', 'line one  \nline two\\\nline three', 'three')
fid('F09', '波浪围栏与四反引号围栏', '~~~py\nprint(1)\n~~~\n\n````md\n```js\nx\n```\n````', 'print(1)')
fid('F10', '自动链接与引用式链接', 'see <https://e.com> and [a][ref] ok\n\n[ref]: https://e.com', 'ok')
fid('F11', '行内 HTML', 'a <span style="color:red">r</span> b <kbd>K</kbd> tail', 'tail')
fid('F21', '4 空格缩进的嵌套列表(改的就是这一块)', '- a\n    - b\n    - c', 'c')
fid('F22', '三种分割线写法(改的是旁边的段落)', 'top\n\n---\n\n***\n\n___\n\nend', 'end')
fid('F23', '带标题的链接与尖括号地址', 'a [t](<my file.md> "Title") b ![img](p.png "T") tail', 'tail')
fid('F24', '星号强调与下划线混用、三星粗斜', 'x *a* _b_ ***c*** __*d*__ tail', 'tail')
fid('F25', '标签紧贴行首与转义井号', '#tag at start and C\\# tail', 'tail')
fid('F12', '已证缺陷:行内代码里的反斜杠', 'before `$a\\_b$ and $\\{x\\}$` after', 'be')
fid('F13', '连续空行', 'a\n\n\n\nb', 'a')
fid('F14', '从 5 开始的编号', '5. a\n6. b', 'b')
fid('F15', '中文紧挨加粗', '中文**加粗**中文 尾', '尾')
fid('F16', '同一段里的双链、标签、公式', 'x [[Note|别名]] #tag $a_b$ ==hl== %%c%% y', 'y')
fid('F17', '软换行(单个换行)', 'line one\nline two\nline three', 'three')
fid('F18', '标题尾部的 # 与多余空格', '##  Spaced title ##\n\ntext', 'title')
fid('F19', '缩进代码块与制表符', 'para\n\n    indented code\n\n\ttabbed', 'para')
fid('F20', '待办的大写 X 与星号待办', '- [X] a\n* [ ] b', 'b')
// 后补的一批保存保真场景(编号接着排)
fid('F26', '普通文字里的下划线与星号(改的就是这一段)', 'snake_case and 5 * 3 tail', 'and')
fid('F27', '用 Tab 缩进的嵌套列表(改的就是这一块)', '- a\n\t- b\n\t\t- c', 'a')
fid('F28', 'callout:改正文里的一个字', '> [!note] Title\n> body tail', 'body')
fid('F29', '相邻的脚注定义:改其中一条', 'text[^1] and[^2] end\n\n[^1]: one\n[^2]: two', 'one')
fid('F30', '带空格的图片地址(改的是别的段落)', '![](<a b.png>)\n\nother tail', 'tail')
fid('F31', '全写成 1. 的编号列表', '1. a\n1. b\n1. c', 'a')
fid('F32', '长列表里只改一项,别的项写法不同', '- one\n- _two_ and __x__\n- [link](<my file.md>)\n- 1 * 2 tail', 'one')
fid('F33', '被改的段落紧挨着两条空行', 'a tail\n\n\nb', 'tail')

// ── P 长文键入延迟(生成的夹具)────────────────────────────
const longDoc = (paras, formulas) => {
  const out = []
  for (let i = 0; i < paras; i++) {
    const f = i < formulas ? ` $a_{${i}}+b^{2}$ and [[Note ${i}]]` : ''
    out.push(`Paragraph ${i} lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor **bold ${i}** incididunt ut labore.${f}`)
  }
  out.splice(Math.floor(paras / 2), 0, 'MIDDLE anchor here')
  return out.join('\n\n')
}
const perf = (id, title, paras, formulas) => add(id, 'perf', title, longDoc(paras, formulas), [
  { caret: { after: 'MIDDLE anchor' } }, { wait: 800 }, { perf: { text: ' the quick brown fox jumps', delay: 60 } }, { snap: '打完', shot: false },
])
perf('P01', '短文基线(40 段)', 40, 10)
perf('P02', '长文(600 段,含 200 处公式与双链)', 600, 200)
perf('P03', '超长文(2400 段,含 800 处公式与双链)', 2400, 800)

module.exports = S
