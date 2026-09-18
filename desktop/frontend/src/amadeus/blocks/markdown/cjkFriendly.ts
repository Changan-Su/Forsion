// attention run(`**` / `*` / `~~`)的 CJK 友好**解析**。
//
// 病:CommonMark 的 flanking 只看定界符紧邻两个字符是空白 / 标点 / 其它。闭合定界符内侧是标点、
// 外侧是汉字时不成立 —— `**注意：**后面`、`**「引号」**后面`、`~~（备注）~~继续` 在编辑器里显示字面
// `**`,下次保存被 remark 转义成 `\*\*注意：\*\*后面`,**不可逆**。编辑器里自己加的 mark 没事
// (attentionFlanking 落 `&#x540E;`),中招的是磁盘上已经这样写的串:AI 输出 / 剪藏 / 粘贴最常带进来
// (09-18 实测 WMOSv11 存量 0 篇,是增量入口)。Obsidian 同病。
//
// 修法:只换解析侧 —— micromark 的 CJK 友好扩展(tats-u/markdown-cjk-friendly:中日韩标点按字母算)。
// 落盘侧不动:attentionFlanking 照旧把外侧汉字编成字符引用,`**注意：**后面` 过一次 Amadeus 就成了
// CommonMark 也认的 `**注意：**&#x540E;面`(240 万个单对串实测,不含 emoji 时落盘形在 CommonMark 下
// 与本解析 100% 同树;Obsidian 按 CommonMark 走,未在 Obsidian 里实测)。
//
// ⚠️ 只用 parseOnly:包的 bidi / serializeOnly 那半会落干净的 `**注意：**后面`(Obsidian 不认),
//    而且在 milkdown 里本来就是死代码(remarkStringifyOptionsCtx.handlers 恒胜,见 attentionFlanking.ts 文件头)。
// ⚠️ 必须挂在 `.use(gfm)` **之后**:删除线扩展要压过 remark-gfm 注册的 `~` tokenizer(micromark 后注册的先试)。
// ponytail: 已知天花板(规范使然,库存 0 例)—— emoji 独占 mark 且紧贴 ASCII 字母/数字(`**😀**a`):
//    micromark 按 UTF-16 码元把代理项当字母、认成加粗;本扩展按码点把 emoji 当标点 → 字面,保存时转义。
//    真要保就得改扩展的字符分类,等真有人这么写再说。
import { $remark } from '@milkdown/kit/utils'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'

/** 两个 parseOnly 合一(都只往 `data().micromarkExtensions` 推扩展)。单测直接吃这个,与生产同一份。 */
export function remarkCjkFriendlyParse(this: unknown): void {
  remarkCjkFriendly.call(this)
  remarkCjkFriendlyStrikethrough.call(this)
}

/** 挂进编辑器:`.use(cjkFriendlyRemark)`,紧跟 `.use(gfm)`。 */
export const cjkFriendlyRemark = $remark('amadeusCjkFriendly', () => remarkCjkFriendlyParse)
