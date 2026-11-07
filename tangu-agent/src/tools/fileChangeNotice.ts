/**
 * 变动感知的通知文本:readState.collectExternalChanges 扫出「文件工具之外」的改动(用户在编辑器里写、别的程序、
 * run_bash)→ 这里出一段给模型看的英文通知,每个文件一段封顶的统一 diff。
 *
 * agentLoop 两处用它(都只进本 run 的上下文,不落库、不上屏、不进 Historian 起标题):
 * - 每轮开头:fileChangeSection 作为 <runtime_context> 的一段;
 * - run 内每次续调模型前:同一段包进 <file_changes>,作为一条 user 消息追加在对话尾部(同 NO_VISION_NOTE 的做法,
 *   前缀缓存不受影响;本 run 之后的每次调用都还看得见)。
 *
 * 通知不推写闸(见 readState.ts 头注 ②):整篇 write_file 之前仍要先 read_file。
 */
import path from 'node:path';
import { diffIndices } from 'node-diff3';
import { collectExternalChanges, type ExternalChange } from './readState.js';
import { checkReadPath } from './fsPolicy.js';

/** 带 diff 详写的文件数上限;多出来的只列名字。 */
export const NOTICE_MAX_FILES = 8;
/** 整段通知的字符上限(详写部分);超了余下的只列名字。 */
export const NOTICE_MAX_CHARS = 12_000;
/** 单个文件 diff 的行数 / 字符上限。 */
export const DIFF_MAX_LINES = 60;
export const DIFF_MAX_CHARS = 4_000;
/** diff 里单行的显示上限。 */
const LINE_MAX_CHARS = 300;
const CONTEXT = 2;
/** 剥掉公共首尾之后两侧行数合计超过这个就不做行 diff(只说「大改了」),防 LCS 吃 CPU。 */
const LCS_MAX_LINES = 3000;
/** 「也改了」名单最多列几个。 */
const OVERFLOW_NAMES = 20;

interface Block { aStart: number; aLen: number; bStart: number; bLen: number }

function splitLines(t: string): string[] {
  const lines = t.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 行级 diff 块;null = 改动太大不做行 diff。 */
function diffBlocks(a: string[], b: string[]): Block[] | null {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let ea = a.length;
  let eb = b.length;
  while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  if (p === ea && p === eb) return [];
  if (p === ea || p === eb) return [{ aStart: p, aLen: ea - p, bStart: p, bLen: eb - p }];
  if ((ea - p) + (eb - p) > LCS_MAX_LINES) return null;
  return diffIndices(a.slice(p, ea), b.slice(p, eb)).map((d) => ({
    aStart: p + d.buffer1[0], aLen: d.buffer1[1], bStart: p + d.buffer2[0], bLen: d.buffer2[1],
  }));
}

function hunkHeader(aS: number, bS: number, body: string[]): string {
  let aN = 0;
  let bN = 0;
  for (const l of body) {
    if (l[0] !== '+') aN++;
    if (l[0] !== '-') bN++;
  }
  return `@@ -${aN ? aS + 1 : aS},${aN} +${bN ? bS + 1 : bS},${bN} @@`;
}

const shown = (prefix: string, line: string): string => {
  const l = line.endsWith('\r') ? line.slice(0, -1) : line;
  return prefix + (l.length > LINE_MAX_CHARS ? `${l.slice(0, LINE_MAX_CHARS)}… [line cut]` : l);
};

export interface LineDiff { patch: string; truncated: boolean; adds: number; dels: number }

/** before → after 的统一 diff(只有 hunk 部分,真实行号,2 行上下文,封顶);null = 改动太大。 */
export function lineDiff(before: string, after: string, maxLines = DIFF_MAX_LINES, maxChars = DIFF_MAX_CHARS): LineDiff | null {
  const a = splitLines(before);
  const b = splitLines(after);
  const blocks = diffBlocks(a, b);
  if (!blocks) return null;
  let adds = 0;
  let dels = 0;
  for (const blk of blocks) { adds += blk.bLen; dels += blk.aLen; }
  const out: string[] = [];
  let chars = 0;
  let truncated = false;
  let i = 0;
  while (i < blocks.length) {
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1].aStart - (blocks[j].aStart + blocks[j].aLen) <= 2 * CONTEXT) j++;
    const first = blocks[i];
    const last = blocks[j];
    const pre = Math.min(CONTEXT, first.aStart);
    const post = Math.min(CONTEXT, a.length - (last.aStart + last.aLen));
    let ai = first.aStart - pre;
    let bi = first.bStart - pre;
    const aS = ai;
    const bS = bi;
    const body: string[] = [];
    for (let k = i; k <= j; k++) {
      const blk = blocks[k];
      while (ai < blk.aStart) { body.push(shown(' ', a[ai++])); bi++; }
      for (let x = 0; x < blk.aLen; x++) body.push(shown('-', a[ai++]));
      for (let x = 0; x < blk.bLen; x++) body.push(shown('+', b[bi++]));
    }
    for (let x = 0; x < post; x++) { body.push(shown(' ', a[ai++])); bi++; }
    // 装不下就只留装得下的行,头部计数按留下的行重算
    let keep = 0;
    let used = 0;
    const roomLines = maxLines - out.length - 1;
    while (keep < body.length && keep < roomLines && chars + used + body[keep].length + 1 <= maxChars) used += body[keep++].length + 1;
    if (keep < body.length) {
      if (keep > 0) out.push(hunkHeader(aS, bS, body.slice(0, keep)), ...body.slice(0, keep));
      truncated = true;
      break;
    }
    out.push(hunkHeader(aS, bS, body), ...body);
    chars += used;
    i = j + 1;
  }
  return { patch: out.join('\n'), truncated, adds, dels };
}

const displayPath = (abs: string, cwd?: string): string => {
  if (!cwd) return abs;
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
};

function kindLabel(c: ExternalChange): string {
  switch (c.kind) {
    case 'deleted': return 'deleted';
    case 'created': return 're-created (it had been deleted)';
    case 'beforeWrite': return 'changed before your last edit to it was applied (your edit landed on this newer version, so the file now has both)';
    default: return 'modified';
  }
}

/** 一个文件的详写段。 */
function renderOne(c: ExternalChange, cwd?: string): string {
  const head = `### ${displayPath(c.abs, cwd)} — ${kindLabel(c)}`;
  if (c.kind === 'deleted') return head;
  if (c.note === 'withheld') return `${head}\n(content not shown: the path now resolves to a protected file)`;
  if (c.note === 'binary') return `${head}\n(binary content, no diff)`;
  if (c.before === undefined || c.after === undefined || c.note === 'large') {
    return `${head}\n(no diff available: the file is too large to keep a copy of — read_file it if you need the current content)`;
  }
  const d = lineDiff(c.before, c.after);
  if (!d) return `${head}\n(changed extensively — read_file it again before relying on its content)`;
  if (!d.patch) return `${head}\n(no line-level difference: only line endings or the trailing newline changed)`;
  return `${head} (+${d.adds} −${d.dels} lines)\n\`\`\`diff\n${d.patch}\n\`\`\`` +
    (d.truncated ? '\n(diff truncated — read_file the file for the rest)' : '');
}

export const FILE_CHANGES_HEADING = '## Files changed outside your file tools';
const PREAMBLE =
  'Since you last read or wrote them, these files were changed by something other than your file-editing tools: ' +
  'the user (for example typing in the editor), another program, or a shell command. Your earlier view of them is out of date. ' +
  'Take the changes into account as you continue: work from the current content, keep these changes (do not revert them unless the user asks), and never write an older copy back over them. ' +
  'edit_file / multi_edit / apply_patch apply to the current file; read_file a file again before replacing it as a whole with write_file. ' +
  'Diffs are old → current (- removed, + added).';

/** 通知正文(不含外层标签);没有改动 = null。 */
export function renderFileChanges(changes: ExternalChange[], cwd?: string): string | null {
  if (!changes.length) return null;
  const parts: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < changes.length && parts.length < NOTICE_MAX_FILES; i++) {
    const one = renderOne(changes[i], cwd);
    if (parts.length && used + one.length > NOTICE_MAX_CHARS) break;
    parts.push(one);
    used += one.length;
  }
  const rest = changes.slice(i);
  if (rest.length) {
    const names = rest.slice(0, OVERFLOW_NAMES).map((c) => `${displayPath(c.abs, cwd)} (${c.kind === 'beforeWrite' ? 'modified' : c.kind})`);
    parts.push(`Also changed: ${names.join(', ')}${rest.length > OVERFLOW_NAMES ? `, and ${rest.length - OVERFLOW_NAMES} more` : ''} — read_file them if they matter.`);
  }
  return `${FILE_CHANGES_HEADING}\n${PREAMBLE}\n\n${parts.join('\n\n')}`;
}

/** run 内续调前那条 user 消息的外层(开头的 <runtime_context> 说的是「本 run 开头注入」,这里另起一个标签)。 */
export function wrapMidRunFileChanges(section: string): string {
  return `<file_changes>\nInjected by the harness between your tool calls (NOT written by the user).\n\n${section}\n</file_changes>`;
}

/** TANGU_FILE_CHANGE_NOTICE=off|0|false 关掉通知(排查 / live 台架负对照用)。 */
const noticeOff = (): boolean => /^(off|0|false)$/i.test(String(process.env.TANGU_FILE_CHANGE_NOTICE || '').trim());

/**
 * 扫一遍、出通知正文;没改动 / 出错 / 关掉了 = null(绝不因为这个挡 run)。日志只记数量与路径,不记内容。
 */
export async function fileChangeSection(
  ctx: { sessionId?: string; cwd?: string; runId?: string },
  where: 'turn-start' | 'mid-run',
): Promise<string | null> {
  if (noticeOff()) return null;
  try {
    const changes = await collectExternalChanges(ctx, { canRead: (abs) => { try { return checkReadPath(abs).ok; } catch { return false; } } });
    if (!changes.length) return null;
    const text = renderFileChanges(changes, ctx.cwd);
    console.log(`[filechange] run=${ctx.runId || '-'} ${where}: ${changes.length} change(s) outside file tools: ${changes.map((c) => `${displayPath(c.abs, ctx.cwd)}:${c.kind}`).join(', ')} (${text?.length ?? 0} chars)`);
    return text;
  } catch (e: any) {
    console.warn(`[filechange] scan failed (ignored): ${e?.message || e}`);
    return null;
  }
}
