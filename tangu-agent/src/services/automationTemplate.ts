/**
 * 动作参数里的模板变量 —— `{{row.名称}}` / `{{row.<列 id>}}` / `{{target.X}}` / `{{now}}` / `{{today}}`,
 * 以及算术 `{{= 表达式 }}`(表达式语法 = 公式列引擎 dbFormula:`{{= {target.数量} - {row.出库数量} }}`,
 * 列引用写 `{row.X}` / `{target.X}` / `{X}`(裸名 = row);结果转成字符串再落进单元格/通知)。
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
 * 取值只在**显式构造的映射**里查(rowVars/rowTyped 按 db.columns 建),不做任何 JS 属性访问 ——
 * 于是 `{{row.__proto__}}` 只是一次查不到的键,不是原型链。
 * 算术表达式走 dbFormula.evalFormula(无 eval、无依赖的小解释器),未知列/语法错/除零一律**抛**:
 * 动作失败即停,绝不把脏值写进表。
 */
import type { TriggerContext, TriggerRow } from './museTriggers.js';
import { evalFormula, FormulaError } from './dbFormula.js';
import type { CellValue } from './amadeusDb.js';

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

function localDate(now: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** `row.X` / `target.X` → 哪一行 + 键;裸 `X` = row。 */
function splitRef(name: string): { which: 'row' | 'target'; key: string } {
  if (name.startsWith('row.')) return { which: 'row', key: name.slice(4) };
  if (name.startsWith('target.')) return { which: 'target', key: name.slice(7) };
  return { which: 'row', key: name };
}

/** 变量名 → 值;查不到返回 null(调用方保留原样,让人一眼看出哪个变量没接上)。 */
function lookup(name: string, ctx: TriggerContext | undefined, now: Date): string | null {
  if (name === 'now') return now.toLocaleString();
  if (name === 'today') return localDate(now);
  if (name === 'row.id') return ctx?.row?.id ?? null;
  if (name === 'target.id') return ctx?.target?.id ?? null;
  if (name.startsWith('row.') || name.startsWith('target.')) {
    const { which, key } = splitRef(name);
    const cells = which === 'row' ? ctx?.row?.cells : ctx?.target?.cells;
    // Object.hasOwn:cells 是我们自己按列建的普通对象,但仍显式只认自有属性
    return cells && Object.hasOwn(cells, key) ? cells[key] : null;
  }
  return null;
}

/** 带类型取值(算术用):typed 图优先,老上下文没有 typed 时退回字符串图;查不到抛 FormulaError(公式引擎契约)。 */
function typedLookup(name: string, ctx: TriggerContext | undefined): CellValue {
  const { which, key } = splitRef(name);
  const row: TriggerRow | undefined = which === 'row' ? ctx?.row : ctx?.target;
  if (!row) throw new FormulaError(`没有 ${which} 上下文,取不到 {${name}}`);
  if (key === 'id') return row.id;
  if (row.typed && Object.hasOwn(row.typed, key)) return row.typed[key];
  if (Object.hasOwn(row.cells, key)) return row.cells[key];
  throw new FormulaError(`未知列 {${name}}`);
}

/** 算术结果 → 字符串:null → ''(空格子给 number 列 coerce 成 null,别写成 "null");数组按 ', ' 拼。 */
function cellToStr(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/**
 * 找 `{{=` 的闭合位:括号深度扫描 —— `{` +1、`}` -1,深度 0 时遇到 `}}` 即闭合。
 * 表达式里的列引用 `{row.X}` 自带一层花括号,不能用「第一个 }}」结束(`{{= {a}}}` 那种会截错)。
 * 返回表达式的 [start, end) 与整段的结束下标;未闭合 → null。
 */
function findArithEnd(input: string, exprStart: number): { exprEnd: number; end: number } | null {
  let depth = 0;
  for (let i = exprStart; i < input.length; i++) {
    const ch = input[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth > 0) depth--;
      else if (input[i + 1] === '}') return { exprEnd: i, end: i + 2 };
      else return null; // 单个 } 在深度 0:不是闭合,当语法错
    }
  }
  return null;
}

/** 普通变量替换(`{{row.X}}` 等)。 */
function expandVars(seg: string, ctx: TriggerContext | undefined, now: Date): string {
  return seg.replace(VAR_RE, (whole, name: string) => {
    const v = lookup(name, ctx, now);
    return v === null ? whole : sanitize(v);
  });
}

/**
 * 在允许插值的字段上展开模板。ctx 缺席 → 所有 row.* 原样保留;`{{= }}` 出错 → 抛(动作失败即停)。
 * 单趟切段:`{{= expr }}` 段求值,其余段做普通替换 —— 算术结果**不再**回炉替换,
 * 否则表格里一段恰好长成 `{{row.X}}` 的文字会被二次展开成别的格子。
 */
export function expandTemplate(input: string, ctx: TriggerContext | undefined, now: Date = new Date()): string {
  if (!input || !input.includes('{{')) return input;
  let out = '';
  let i = 0;
  for (;;) {
    const at = input.indexOf('{{=', i);
    if (at < 0) { out += expandVars(input.slice(i), ctx, now); break; }
    out += expandVars(input.slice(i, at), ctx, now);
    const found = findArithEnd(input, at + 3);
    if (!found) throw new FormulaError(`算术模板未闭合:${input.slice(at, at + 40)}`);
    const src = input.slice(at + 3, found.exprEnd).trim();
    if (!src) throw new FormulaError('空的算术模板 {{= }}');
    const v = evalFormula(src, (name) => typedLookup(name, ctx), { today: localDate(now) });
    out += sanitize(cellToStr(v));
    i = found.end;
  }
  return out.slice(0, MAX_TOTAL);
}

/** 对一组单元格值批量展开。 */
export function expandCells(cells: Record<string, string>, ctx: TriggerContext | undefined, now: Date = new Date()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cells)) out[k] = expandTemplate(v, ctx, now);
  return out;
}
