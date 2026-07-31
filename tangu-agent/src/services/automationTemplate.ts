/**
 * 动作参数里的模板变量 —— `{{row.名称}}` / `{{row.<列 id>}}` / `{{now}}` / `{{trigger}}`。
 *
 * ⚠️ **允许插值的字段是白名单,不是黑名单**(codex 评审定的,只有这两处):
 *   · notify 的 title / body
 *   · db_row_add / db_row_edit 的单元格值
 * 明确**不许**插值的地方,以及为什么转义救不了:
 *   · `tool_call.args` —— 每个工具的每个参数是各自的解释器。给 `run_bash.cmd` 做 shell 转义,
 *     挡不住 `write_file.path` 的路径选择、`web_fetch.url` 的 SSRF、`web_search.query` 把私有行
 *     内容发到外网,更挡不住第三方插件工具自己定义的语义。
 *   · `agent_run.prompt` —— 无人值守 run 是 full-auto。把用户表格里的一行文字塞进提示词,
 *     等于让表格内容指挥一个能 run_bash 的 agent。LLM 没有可靠的字符串执行边界,引号包不住。
 *   · 路径 / URL / rowId / columnId —— 目标本身不能由数据决定,否则等于把写入落点交给数据。
 *
 * 取值只在**显式构造的映射**里查(rowVars 按 db.columns 建),不做任何 JS 属性访问 ——
 * 于是 `{{row.__proto__}}` 只是一次查不到的键,不是原型链。
 */
import type { TriggerContext } from './museTriggers.js';

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.\-一-龥]+)\s*\}\}/g;

/** 展开后的单值上限:防一行超长表格内容把通知/单元格撑爆。 */
const MAX_VALUE = 500;
/** 展开后的整串上限。 */
const MAX_TOTAL = 4000;

/**
 * 消毒:
 *  · `<!-- a 3 -->` 这类 Amadeus **块标记**必须打断 —— 它一旦作为独立一行落进 markdown,
 *    重新加载时会被编译器当成真的块边界,把页面结构劈开。
 *  · 顺带掐掉裸 HTML 注释的开头,避免通知正文里塞进不可见内容。
 */
function sanitize(v: string): string {
  return v.replace(/<!--/g, '<!‑-').replace(/-->/g, '-‑>').replace(/[\r\n]+/g, ' ').slice(0, MAX_VALUE);
}

/** 变量名 → 值;查不到返回 null(调用方保留原样,让人一眼看出哪个变量没接上)。 */
function lookup(name: string, ctx: TriggerContext | undefined, now: Date): string | null {
  if (name === 'now') return now.toLocaleString();
  if (name === 'today') {
    const p = (x: number): string => String(x).padStart(2, '0');
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  }
  if (name === 'row.id') return ctx?.row?.id ?? null;
  if (name.startsWith('row.')) {
    const key = name.slice(4);
    const cells = ctx?.row?.cells;
    // Object.hasOwn:cells 是我们自己按列建的普通对象,但仍显式只认自有属性
    return cells && Object.hasOwn(cells, key) ? cells[key] : null;
  }
  return null;
}

/** 在允许插值的字段上展开模板。ctx 缺席 → 所有 row.* 原样保留。 */
export function expandTemplate(input: string, ctx: TriggerContext | undefined, now: Date = new Date()): string {
  if (!input || !input.includes('{{')) return input;
  const out = input.replace(VAR_RE, (whole, name: string) => {
    const v = lookup(name, ctx, now);
    return v === null ? whole : sanitize(v);
  });
  return out.slice(0, MAX_TOTAL);
}

/** 对一组单元格值批量展开。 */
export function expandCells(cells: Record<string, string>, ctx: TriggerContext | undefined, now: Date = new Date()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cells)) out[k] = expandTemplate(v, ctx, now);
  return out;
}
