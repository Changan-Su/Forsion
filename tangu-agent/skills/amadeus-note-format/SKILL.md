---
name: Amadeus 笔记格式
description: 当你要动 Forsion Amadeus 笔记库里的 `.md` 文件——新建一篇笔记、改写已有笔记、整理/合并/重排内容、动 frontmatter,或用户报「笔记打开变成一大块 / 分栏没了 / 画布上的卡片不见了」——时,一定要用这个技能。库里出现 `X (conflict 日期).md` / `X (recovered 日期).md` 这类同步冲突副本、或用户要合并同步冲突时也必须先加载它(第十节:子集副本直接删,否则并集合并;画布表格真分叉不合并)。Amadeus 笔记有两种形态:多数是纯 markdown 素文件(你随手写就对),少数带 `amadeus_schema` 结构键的文件把分栏与画布几何存在 frontmatter、用 `<!-- a id -->` 锚划分辖域。凭直觉整份重写一篇结构化笔记会静默毁掉用户的分栏和画布。本技能给出判别法、两条毁档不变式和一个交付前必跑的校验脚本。
version: 1.2.0
author: Forsion
category: Forsion
---

# Amadeus 笔记格式(v4)

## 一、先记住这一句

**新建笔记就写纯 markdown —— 零 frontmatter、零标记。** 这是 v4 的常态形态(「素文件」),
库里多数文件长这样。agent / Obsidian / 剪贴板写出来的普通 md **天生就是合法的 Amadeus 笔记**,
不需要任何转换,也不要「贴心」地补上 `amadeus_*` 键。

本技能余下的篇幅全是为了另一件事:**当你打开的笔记已经是结构化文件时,不要把它写坏。**

## 二、打开一份笔记,先看 frontmatter 判是哪一种

判据只看 frontmatter 的键,不看正文里有没有标记。**按下面这个顺序依次判**(与宿主 `classifyPageSource` 同序,先命中先算):

| frontmatter | 是什么 | 你该怎么做 |
|---|---|---|
| `amadeus_schema` 的主版本号 **> 4**(如 `amadeus.page/5`) | **未来格式**,比你新 | **一个字都别改**。宿主自己都不解析它——整篇当单块只读、编译器拒写。锚与正文语义未知,按 v4/v3 的规矩去改必然写坏。告诉用户这文件需要更新版本的 app |
| `amadeus_schema` 主版本号 **= 4** | **v4 结构化文件**(有分栏或画布) | 照第三、四节的规矩改 |
| 有任何**其他** `amadeus_` 前缀键(如 `amadeus_page`、`amadeus.page/3`) | **v3 老文件** | **原样保守改**:frontmatter 与所有 `<!-- a id -->` 标记逐字保留,只改锚辖域内的正文。**绝不手工迁到 v4** —— 用户在 app 里打开时编辑器会自己升,你插一手只会两边打架 |
| 没有任何 `amadeus_` 键 | **v4 素文件**(纯 markdown) | 当普通 md 自由编辑 |

⚠️ 顺序是有意义的:**主版本号先判、`amadeus_` 前缀后判**。所以一份 v4 文件里出现你不认识的 `amadeus_*` 键,它**仍然是 v4**,不会因此掉进 v3 —— 这一点直接决定了下一节第 2 条怎么做。

`icon:`、`cover:`、`children:`、`tags:` 这类**非** `amadeus_` 前缀的键是用户和插件的地盘,任何形态下都逐字保留。

## 三、锚:`<!-- a id -->`

```markdown
<!-- a c1 -->
这张卡/这一列的内容

<!-- /a c1 -->
```

- 独占一行的 HTML 注释,所以任何 md 阅读器都渲染成空 —— 笔记看上去仍是干净的 markdown。
- id 字符集 `[A-Za-z0-9_-]`(下划线与连字符都合法)。
- **辖域** = 锚行到**下一个锚或文件尾**,前提是这枚锚**被 `amadeus_layout` 或 `amadeus_canvas` 引用**;
  没被引用的锚是**惰性**的,只给紧随其后的一个块命名(供 `![[笔记#id]]` 引用),不切分文档。
- **闭合符 `<!-- /a id -->`** 是画布卡片专用(2026-08-19 起写侧恒发),它让卡片能合法住在文档任意位置。
  分栏**不发**闭合符,靠行尾的 `tail` 锚封底。闭合符**只认自家 id** —— `<!-- /a x -->` 收束不了 `<!-- a y -->` 的辖域,
  不匹配的闭合符按普通正文原样留着。旧文件没有闭合符也照读(辖域到下一开锚)。
- **锚 id 永不重编号、永不回收。** 别为了整齐给锚重排号:`![[笔记#id]]` 这类跨笔记引用会当场断掉。
  删掉一段内容时,把 frontmatter 里引用该锚的条目一并删掉。

## 四、两条会毁档的不变式

### 1. `amadeus_schema` 在场 ⟺ `amadeus_layout` 或 `amadeus_canvas` 在场

两个方向都必须成立:

```yaml
# ❌ 有画布没 schema → 文件被判成 v3 → 打开时被拽进补号管线原地改写 = 毁档
amadeus_canvas: {"v":1,...}

# ❌ 有 schema 没结构 → 半吊子文件
amadeus_schema: amadeus.page/4

# ✅
amadeus_schema: amadeus.page/4
amadeus_canvas: {"v":1,...}
```

### 2. `amadeus_` 是保留前缀:**别新造,更别删**

我们自己写的结构键就三个:`amadeus_schema` / `amadeus_layout` / `amadeus_canvas`。**要存你自己的东西,
用不带这个前缀的键名**(`.mindmap.md` 的 `mindmap:` 键正是这么做的)。原因分两种情况,方向相反:

- **素文件里加一个 `amadeus_*` 键** = 把一份好好的纯 markdown 降级成 v3 文件,下次打开被拽进 v3 管线补号改写。
- **已经是 v4 的文件里出现你不认识的 `amadeus_*` 键** —— **原样留着,绝对不要删**。它不会让文件掉进 v3
  (识别顺序见上节),它是**更新版本的客户端写的不透明扩展元数据**:宿主对这类键只承诺字节保全、不承诺
  懂它的语义,专门做了「v4 来源就保留未知 `amadeus_*`」的处理。你把它当垃圾清掉,等于让老端一次保存就把
  新端的数据静默吞了 —— 这正是宿主刻意避免的那件事。**不认识 = 不要动**,这条比"整洁"重要。

## 五、分栏 `amadeus_layout`

```yaml
amadeus_schema: amadeus.page/4
amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["cg7qn"],"width":1},{"refs":["cu671"],"width":1}],"tail":"cybwa"}]}
```

- `v` 恒为 `4`;一行 = 一组并排的列;`refs` 里的锚**必须在源文里连续出现**,`width` 是比例。
- `tail` = 行尾封底锚。因为辖域到「下一锚或文件尾」,分栏行若在文件中间,末列会把行后的正文整个吞进去 —— tail 锚就是那道界标。
- 只描述分栏行;**没被引用的内容一律按源序自然流**,不需要在这里登记。
- 读侧 fail-closed:refs 不连续 / 指向不存在的锚 → 整行退回自然流(不毁内容,但用户的分栏没了)。

## 六、画布 `amadeus_canvas`

```yaml
amadeus_schema: amadeus.page/4
amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":6,"y":-25,"w":515},"cards":[{"ref":"cubeh","x":597,"y":1,"w":400}],"tree":{"cubeh":"m:"},"elements":[]}
```

正文里对应地:

```markdown
主卡的自然流正文照旧写……

<!-- a cubeh -->

这张卡片的内容

<!-- /a cubeh -->
```

- **卡片 = 一段锚辖域**;主卡 = 所有没入卡的自然流。画布上叫「节点 / 卡片」,**别管它叫「块」**(块是正文里带 ⠿ 拖拽条的那种单元)。
- `mode`:`"canvas"` = 打开默认进画布,`"doc"`/缺省 = 文档模式。坐标一律整数。
- `tree` = 节点层级 `{子卡锚: 父卡锚}`,`"m:"` 是主卡哨兵。**层级是唯一真源**,画布上那条线只是它的呈现 —— 绝不在 `elements` 里另存一条连线来表示父子。
- `elements` = 白板元素(形状/连接线/文本),**只在 frontmatter 里,不进正文**。你看不懂的元素条目**原样保管**,别删别改。
- **互斥不变式**:`cards[].ref` 与 `amadeus_layout` 的 refs / tail **绝不能有交集** —— 同一枚锚被两个折叠器抢,画布侧会让位、那张卡当场散回正文。
- 读侧按卡降级:`ref` 找不到对应锚 → 该卡忽略;整段 JSON 非法 → 逐字保留、本次当作没有画布。

## 七、改已有笔记的纪律

1. **外科式改 frontmatter**:只动你要动的那一行。整段重写会抹掉用户和插件的键。
2. **别整文重排**。未编辑区域应当字节稳定 —— 顺手「格式化一下」会把 round-trip 契约踩碎。
3. **正文改动落在锚辖域之内**。往两枚锚之间加内容是安全的;跨锚搬运内容 = 在改分栏/画布的归属。
4. **不要凭空造锚**。需要新锚时(比如新建一张卡),id 取一个文件内唯一的短随机串,并同时在 `cards`/`layout` 里登记。
5. **这些扩展名不是普通 markdown,别用本技能的规矩改**:`.mindmap.md`(载入 `mindmap-format` 技能)、`.excalidraw.md`、`.db` —— 后两者没有可手写的规范,**一律不要手工编辑**,让用户在 app 里改。

## 八、用哪些工具

| 场景 | 用 | 别用 |
|---|---|---|
| **本机**(提示里给了 vault 绝对路径) | `read_file` / `edit_file` / `write_file` 走真实路径 | `amadeus_*` 笔记读写工具在本机根本不可用 |
| **云端**(没有文件系统) | `amadeus_read_note` / `amadeus_write_note` | 它们**剥掉 frontmatter、按线性重置布局** —— 对结构化笔记是有损的 |
| 找文件 | `amadeus_list_notes`(库相对路径) | |

云端还有两道硬闸,撞上就是撞上了,别绕:`.mindmap.md` / `.excalidraw.md` / `.db` 一律拒写;**frontmatter 里有 `amadeus_canvas` 的画布笔记也拒写**(整份覆盖会抹掉卡片几何)。这两种情况下正确的回答是请用户在 app 里改。

## 九、交付前跑这个校验器

改完结构化笔记别靠肉眼。存成 `check_amadeus.mjs`,`node check_amadeus.mjs <文件>`:

```javascript
import { readFileSync } from 'node:fs';
const raw = readFileSync(process.argv[2], 'utf8'); const errs = [], warns = [];
const done = (line) => { console.log(line);
  warns.forEach((w) => console.log(`⚠️  ${w}`)); errs.forEach((e) => console.log(`❌ ${e}`));
  console.log(errs.length ? `\n不通过:${errs.length} 个问题` : '\n通过'); process.exit(errs.length ? 1 : 0); };
const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
const head = fm ? fm[1] : '', body = fm ? raw.slice(fm[0].length) : raw;
// 键名容忍 YAML 单/双引号写法('amadeus_schema': …),与宿主 AMADEUS_FM_KEY 同口径 —— 只认双引号
// 会把带单引号的结构化文件当成素文件放行,后面所有检查一条都不跑。
const keys = [...head.matchAll(/^['"]?(amadeus_[A-Za-z0-9_-]+)['"]?\s*:/gm)].map((m) => m[1]);
const major = (/^['"]?amadeus_schema['"]?\s*:\s*['"]?amadeus\.page\/(\d+)['"]?\s*$/m.exec(head) || [])[1];
const v4 = major === '4';
if (major && +major > 4) { errs.push(`amadeus_schema 主版本 ${major} 比 v4 新 → 宿主整篇当单块只读、编译器拒写。别改它`); done('未来格式文件'); }
// v4-only 结构键出现在非 v4 文件里 = 毁档形态(v3 自己的 amadeus_layout 是另一套形状,合法)。
const layoutV4 = /^['"]?amadeus_layout['"]?\s*:\s*['"]?\{\s*"v"\s*:\s*4/m.test(head);
if ((keys.includes('amadeus_canvas') || layoutV4) && !v4)
  errs.push('有 amadeus_canvas / v4 分栏却缺 amadeus_schema: amadeus.page/4 → 被判成 v3,打开即补号改写(毁档)');
if (!keys.length) done('素文件(纯 markdown)—— v4 常态,无结构可校验');
if (!v4) done(`v3 文件(键: ${keys.join(', ')})—— 保留 frontmatter 与标记原样,别手工迁 v4`);
if (!keys.includes('amadeus_layout') && !keys.includes('amadeus_canvas'))
  errs.push('有 amadeus_schema 却没有 amadeus_layout / amadeus_canvas → 违反发射不变式');
// ⚠️ 只警告,**不是错误**:v4 文件里的未知 amadeus_* 键是新版客户端的不透明扩展,宿主承诺原样保管。
// 报成错误会诱使人「清理」掉它 = 老端一次保存吞掉新端的数据。别删,也别自己新造。
const extra = keys.filter((k) => !['amadeus_schema', 'amadeus_layout', 'amadeus_canvas'].includes(k));
if (extra.length) warns.push(`不认识的 amadeus_ 键: ${extra.join(', ')} —— 若非你写的,原样留着别删(新端扩展);也别自己新造`);
const OPEN = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->\s*$/, CLOSE = /^<!--\s*\/a\s+([A-Za-z0-9_-]+)\s*-->\s*$/;
const order = [], seen = new Set(); let cur = null;
body.split('\n').forEach((line, i) => {
  const o = OPEN.exec(line);
  if (o) { if (seen.has(o[1])) errs.push(`锚 id 重复: ${o[1]}`); seen.add(o[1]); order.push(o[1]); cur = o[1]; return; }
  const c = CLOSE.exec(line);
  if (c) { if (c[1] === cur) cur = null;
    else warns.push(`第 ${i + 1} 行 <!-- /a ${c[1]} --> 与当前锚(${cur ?? '无'})不匹配 → 不收束,按正文字面留着`); }
});
const jsonOf = (k) => { const m = new RegExp(`^['"]?${k}['"]?\\s*:\\s*(.*)$`, 'm').exec(head); if (!m) return null;
  let s = m[1].trim(); if (/^['"]/.test(s)) s = s.slice(1, -1);
  try { return JSON.parse(s); } catch (e) { errs.push(`${k} 不是合法 JSON: ${e.message}`); return null; } };
const layout = jsonOf('amadeus_layout'), canvas = jsonOf('amadeus_canvas'), lrefs = new Set();
if (layout) { if (layout.v !== 4) errs.push(`amadeus_layout 的 v 必须是 4(当前 ${layout.v})`);
  for (const r of layout.rows || []) {
    for (const col of r.columns || []) for (const ref of col.refs || []) {
      if (!seen.has(ref)) errs.push(`amadeus_layout 引用了不存在的锚 "${ref}"`); lrefs.add(ref); }
    if (r.tail) { if (!seen.has(r.tail)) errs.push(`分栏行 tail 锚 "${r.tail}" 不存在`); lrefs.add(r.tail); }
    const pos = (r.columns || []).flatMap((c) => c.refs || []).map((x) => order.indexOf(x));
    if (pos.some((p, i) => i && p !== pos[i - 1] + 1)) warns.push('分栏行的 refs 在源文里不连续 → 读侧把整行拆回自然流');
  } }
// 画布键是 **fail-closed 整键作废**:下面任何一条不满足,宿主 parseCanvasJson 直接丢掉整个
// amadeus_canvas —— 用户的卡片坐标、连线、白板元素一次全没。所以这些都是错误,不是风格问题。
const num = (v) => typeof v === 'number' && Number.isFinite(v); // 字符串 "900" 不算数
if (canvas) {
  if (canvas.v !== 1) errs.push(`amadeus_canvas 的 v 必须是数字 1(当前 ${JSON.stringify(canvas.v)})→ 整键作废`);
  if (canvas.mode != null && canvas.mode !== 'doc' && canvas.mode !== 'canvas')
    errs.push(`mode 只能是 "doc" 或 "canvas"(当前 ${JSON.stringify(canvas.mode)})→ 整键作废`);
  if (canvas.main != null && (!num(canvas.main.x) || !num(canvas.main.y) || !num(canvas.main.w) || canvas.main.w <= 0))
    errs.push('main 的 x/y 必须是有限数、w 必须 > 0 → 整键作废');
  if (canvas.cards != null && !Array.isArray(canvas.cards)) errs.push('cards 必须是数组 → 整键作废');
  if (canvas.elements != null && !Array.isArray(canvas.elements)) errs.push('elements 必须是数组 → 整键作废');
  const rs = (Array.isArray(canvas.cards) ? canvas.cards : []).map((c) => c?.ref);
  if (new Set(rs).size !== rs.length) errs.push('cards 里同一个 ref 出现两次 → 歧义,整键作废');
}
for (const c of (Array.isArray(canvas?.cards) ? canvas.cards : [])) {
  if (typeof c?.ref !== 'string' || !/^[A-Za-z0-9_-]+$/.test(c.ref)) { errs.push(`卡片 ref 非法: ${JSON.stringify(c?.ref)} → 整键作废`); continue; }
  if (!seen.has(c.ref)) errs.push(`amadeus_canvas 引用了不存在的卡锚 "${c.ref}"`);
  if (lrefs.has(c.ref)) errs.push(`锚 "${c.ref}" 同时被分栏与画布引用 → 违反互斥不变式`);
  if (!num(c.x) || !num(c.y) || !num(c.w) || c.w <= 0) errs.push(`卡片 "${c.ref}" 的 x/y 必须是有限数、w 必须 > 0(w 必写)→ 整键作废`);
  if (c.h != null && (!num(c.h) || c.h < 0)) errs.push(`卡片 "${c.ref}" 的 h 若写就必须是 ≥ 0 的有限数 → 整键作废`); }
for (const [k, v] of Object.entries(canvas?.tree || {}))
  if (v !== 'm:' && !seen.has(v)) errs.push(`tree 里 "${k}" 的父 "${v}" 既不是主卡哨兵 m: 也不是已有锚`);
done(`v4 结构化:锚 ${order.length} 枚,分栏行 ${layout?.rows?.length ?? 0},卡片 ${canvas?.cards?.length ?? 0}`);
```

跑不了 node 就照它的检查项手工核:主版本号 ≤ 4 / schema 与结构同进同退 / 没自造 `amadeus_` 键(也没删别人的)/ 锚 id 不重复 / frontmatter 引用的锚都存在 / 分栏与画布不抢同一枚锚 / 画布的 `v` `mode` 与坐标是合法的真数字。

## 十、同步冲突副本:合并两边,别丢任何一边

### 怎么认、哪边是哪边

| 文件名 | 谁生成的 | 语义 |
|---|---|---|
| `X (conflict YYYY-MM-DD HHmm).md`(同一分钟再冲突带 `-2`、`-3`) | 桌面端同步引擎 | 两台设备各自改了 `X.md`,又拿不到共同祖先。**原位的 `X.md` = 云端(另一台设备)那版;副本 = 本机冲突当时那版** |
| `X (recovered YYYY-MM-DD HHmm).md` | 网页 / 手机端 | `X.md` 在别处被删或改名时,这个编辑器里还有没保存的正文,另存成它。**原位可能已不存在**(改名去了别处):先在库里找同名或最相近的笔记,那才是「另一边」 |

副本生成后也会同步上云,所有设备都看得到;不处理就一直挂着。引擎的 shadow 只记哈希、不存祖先内容,所以你只能做**双向合并**:没有「谁改了什么」的真相,只有两个终态。

### 先判方向:副本是不是原位的子集 —— 原位多出来的不算分叉

**分叉只看一个方向:副本里有没有原位没有的行。原位比副本多出多少内容都不算分叉** —— 原位本来就是更新的那版,多出来的是冲突之后继续写的。两份都读进来,**按顺序对齐**着比(不是「这行在原位某处出现过」):从头逐行走,副本的每一行都要在原位里**按同样的先后顺序**原样找到(重复出现的行要出现同样多次;代码块 / 表格里的空行也算内容,只有普通段落间的空行不算)。唯一的例外是**副本最后一个非空行**:它可以是原位对齐位置那一行的**开头前缀**(冲突当时正打到一半的那行,例如副本末行 `HUMAN.md 用于AGENT ` 对原位的 `HUMAN.md 用于AGENT 约束人类该怎么协作。`);中间的行**不享受前缀**(`TODO` 对 `TODO 已完成` 不算匹配 —— 分不清是打到一半还是用户故意删了后半句)。全部对上 → 副本是原位的**子集**:它只是本机或另一台设备更早的快照,**没有任何只在副本里的内容**。例:副本末行是半截的 `HUMAN.md 用于AGENT `,原位这一行是完整句子、后面还多两段 → 子集,删副本;**不要把「原位有副本没有的内容」说成「两边有分叉」**(2026-09-22 真模型就这样判错过,结果什么都没做)。拿不准就写个几行的脚本按上面的规则算,别靠肉眼;`diff -u 原位 副本` 只该出现 `-` 行,外加末尾那半截前缀的 `-长行/+短行` 一对。任何一行对不上 → 不是子集,走后面的流程(并集合并或硬拒),**宁可多留也不能猜删**。这种情况:

- **不写任何文件**,原位一个字节都不动。所以带 `amadeus_canvas` / `amadeus_layout` 的结构化笔记、`.db` 表、`.excalidraw.md` 画布**同样适用**这条 —— 下一小节的「硬拒」只针对两边真有分叉的情况(2026-09-22 实报:真模型对一篇画布笔记的两个子集副本按硬拒停手,让用户手删,等于没处理)。
- 子集副本里没有任何内容会随它消失,所以用户说「合并 / 处理 / 解决」这个冲突就够了,不必再等一句「删」:本机用 `run_bash` 删副本(**只删原位子集的那份副本,绝不删原位 `X.md`**;删前把两份再读一遍确认没变)。这与第 7 步的「默认保留副本」不冲突 —— 那条是给两边有分叉、并集里可能有该删的段落、需要用户看一眼的情况。云端没有删除工具:如实说「副本已确认是冗余的,但我删不了,请在 app 里删」,**不要把它说成已处理**。
- 回复里说清:副本比原位少了哪几段(或只差半行)、没有独有内容、已删哪几个。多个副本逐个判,任一副本含原位没有的行 → 那一份走下面的流程。

### 不合并的情况(两边真有分叉时才看这条)

副本不是原位的子集(有只在副本里的内容),且任一份是 `.excalidraw.md` / `.db` / `.mindmap.md`,或 frontmatter 里有 `amadeus_canvas` → **不合并,两份都不要动**。画布几何和表格没有可手写的合并法,合了就是毁档。在回复里告诉用户去 app 里二选一(保留一份、删另一份),然后停 —— 别用 `ask_user` 问「留哪份」:你本来就不能替他删任何一份,问了也做不了。

### 合并流程

1. **找副本**:本机用 `glob_files` / `list_files` 找名字里含 `(conflict ` 或 `(recovered ` 的 `.md`;云端 `amadeus_list_notes` 带 `(conflict` / `(recovered`。**一次只处理一对**,用户没点名时先列出来问处理哪一个。
2. **两份完整读进来**,按第二节判形态;结构化文件按第七节的纪律改,锚一枚不动。
3. **逐段比对**(段落、列表项、标题、`[[链接]]` 行各算一段):两边都有 → 留一份;只在原位有 → 云端加的,留;只在副本有 → 本机加的,留。**默认取并集。**「一边有另一边没有」在没有祖先时分不清是「加了」还是「另一边删了」,宁可多留一段让用户删,也不能替用户丢内容。
4. **有证据才当作删除或改名**:副本里 `[[新名]]`、原位里 `[[旧名]]`,而库里只有 `新名.md`(`旧名.md` 不存在)→ 这是改名,只留 `[[新名]]`;两边把同一行改成了不同内容 → 两行都留、紧挨着放,并在回复里点出来让用户挑;除此之外不要猜。
5. **骨架用原位 `X.md`**(它是云端最新):顺序、frontmatter 都以它为准;副本独有的段落插到它在副本里相邻内容的对应位置,找不到相邻就放进对应章节末尾。frontmatter 只并非 `amadeus_` 前缀的键:`children:` / `tags:` 这类列表取并集、原位顺序在前;`icon:` / `cover:` 以原位为准。
6. **写回原位 `X.md`**:本机 `write_file`(或 `edit_file` 逐处插入);云端 `amadeus_write_note`(对结构化笔记有损,第八节说过)。结构化文件写完跑第九节校验器。
7. **副本处置**:**默认保留副本不删**,回复里说清「来自本机 N 段 / 来自云端 N 段 / 两边都改 N 处」,请用户看一眼再删 —— 删除会同步到所有设备。用户在请求里已经说了「合并完删掉副本」,或看完后确认了 → 本机用 `run_bash` 删那个副本文件(**只删副本,绝不删 `X.md`**);云端没有删除工具,请用户在 app 里删。
8. 回复用用户的语言,只说三件事:合了什么、哪几处拿不准、副本处理了没有。

另:`<库根>/.sync-trash/<日期>/` 里是远端删除落到本机时挪进去的文件,不是冲突,别去合并;用户找「被删的笔记」时可以指给他。
