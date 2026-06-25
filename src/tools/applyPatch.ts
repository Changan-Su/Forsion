/**
 * apply_patch 补丁解析 / 应用(纯逻辑,零运行时依赖,可独立单测)。
 *
 * 采用 Codex/OpenAI 公开的文本 apply_patch 信封——模型本身按此格式训练过,合规率最高:
 *
 *   *** Begin Patch
 *   *** Add File: path/new.txt
 *   +新文件第一行
 *   +新文件第二行
 *   *** Update File: path/existing.ts
 *   *** Move to: path/renamed.ts        (可选,紧跟 Update File)
 *   @@ 可选上下文头(类/函数名,仅辅助定位)
 *    不变的上下文行(前导空格)
 *   -被删除的行
 *   +新增的行
 *   *** Delete File: path/gone.txt
 *   *** End Patch
 *
 * 定位策略:每个 hunk 的 oldBlock(上下文 + 删除行)在文件里先**精确**匹配,失败回退**空白不敏感**
 * (按 trim 比较)匹配——抗缩进漂移。定位不到即抛(供调用方整体回滚,绝不半写)。
 *
 * 故意不做(vs Codex):tree-sitter heredoc 提取、PathUri 跨平台推断、streaming parser——
 * 那是 Codex 用 shell `apply_patch <<EOF` 投递补丁才需要;这里补丁经 native tool-call 当字符串参数传入。
 */

export interface Hunk {
  /** @@ 后的上下文头(仅辅助,不参与定位);可空。 */
  context?: string;
  /** 按序的行:' '=上下文不变,'-'=删除,'+'=新增。 */
  lines: Array<{ type: ' ' | '-' | '+'; text: string }>;
}

export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; hunks: Hunk[] };

const SECTION_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

function isSectionHeader(line: string): boolean {
  return SECTION_RE.test(line) || line.trim() === '*** End Patch' || line.trim() === '*** Begin Patch';
}

/**
 * 解析 apply_patch 信封为操作列表。宽容(对齐 Codex lenient):允许无 *** Begin Patch(从首个 File 段起解析),
 * hunk 体里无前缀的行按上下文处理(定位不上会清晰报错而非静默吃掉)。解析不到任何改动 → 抛。
 */
export function parsePatch(text: string): PatchOp[] {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  // 跳到 *** Begin Patch;若先遇到 File 段则就地开始(宽容模型漏写信封头)。
  while (i < lines.length && lines[i].trim() !== '*** Begin Patch') {
    if (SECTION_RE.test(lines[i])) break;
    i++;
  }
  if (i < lines.length && lines[i].trim() === '*** Begin Patch') i++;

  const ops: PatchOp[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '*** End Patch') break;
    const sec = SECTION_RE.exec(line);
    if (!sec) {
      i++; // 段外杂行(空行等)跳过
      continue;
    }
    const kind = sec[1];
    const filePath = sec[2].trim();
    i++;

    if (kind === 'Delete') {
      ops.push({ kind: 'delete', path: filePath });
      continue;
    }

    if (kind === 'Add') {
      const content: string[] = [];
      while (i < lines.length && !isSectionHeader(lines[i]) && lines[i].trim() !== '*** End Patch') {
        const l = lines[i];
        content.push(l.startsWith('+') ? l.slice(1) : l); // Add 行应为 '+' 前缀,宽容去前缀
        i++;
      }
      ops.push({ kind: 'add', path: filePath, content: content.join('\n') });
      continue;
    }

    // Update
    let movePath: string | undefined;
    const mv = i < lines.length ? MOVE_RE.exec(lines[i]) : null;
    if (mv) {
      movePath = mv[1].trim();
      i++;
    }
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    while (i < lines.length && !isSectionHeader(lines[i]) && lines[i].trim() !== '*** End Patch') {
      const l = lines[i];
      if (l.startsWith('@@')) {
        cur = { context: l.slice(2).trim() || undefined, lines: [] };
        hunks.push(cur);
        i++;
        continue;
      }
      if (!cur) {
        cur = { lines: [] };
        hunks.push(cur);
      }
      if (l === '') cur.lines.push({ type: ' ', text: '' }); // 裸空行 = 空白上下文行
      else if (l[0] === ' ' || l[0] === '-' || l[0] === '+') cur.lines.push({ type: l[0] as any, text: l.slice(1) });
      else cur.lines.push({ type: ' ', text: l }); // 无前缀 → 当上下文(定位不上会报错)
      i++;
    }
    ops.push({ kind: 'update', path: filePath, movePath, hunks });
  }

  if (ops.length === 0) {
    throw new Error('apply_patch: 未解析到任何文件改动(检查格式:*** Begin Patch / *** Update File: ... / *** End Patch)');
  }
  return ops;
}

/** 在 fileLines 中从 fromIdx 起定位 oldLines 连续块:先精确,后空白不敏感(trim 比较)。返回起始下标或 -1。 */
function findBlock(fileLines: string[], oldLines: string[], fromIdx: number): number {
  const n = oldLines.length;
  if (n === 0) return -1;
  const last = fileLines.length - n;
  for (let i = Math.max(0, fromIdx); i <= last; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (fileLines[i + k] !== oldLines[k]) { ok = false; break; }
    }
    if (ok) return i;
  }
  // 回退:空白不敏感(抗缩进/尾空白漂移)
  for (let i = Math.max(0, fromIdx); i <= last; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (fileLines[i + k].trim() !== oldLines[k].trim()) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * 把一组 hunk 应用到文件内容,返回新内容。hunk 按序左→右推进(游标避免回头误匹配)。
 * 任一 hunk 定位失败即抛(调用方据此整体放弃,保证原子性)。
 * ponytail: 仅处理 \n;CRLF 文件会在比较时因 \r 落到空白不敏感回退,如需精确 CRLF 再加归一化。
 */
export function applyHunksToContent(content: string, hunks: Hunk[]): string {
  let lines = content.split('\n');
  let cursor = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((l) => l.type === ' ' || l.type === '-').map((l) => l.text);
    const newLines = hunk.lines.filter((l) => l.type === ' ' || l.type === '+').map((l) => l.text);
    if (oldLines.length === 0) {
      throw new Error('apply_patch: hunk 缺少上下文/删除行,无法定位(纯插入请带至少一行上下文)');
    }
    const idx = findBlock(lines, oldLines, cursor);
    if (idx === -1) {
      const hint = oldLines.slice(0, 3).join('\\n');
      throw new Error(`apply_patch: 无法定位 hunk 上下文(原文可能已变,请重读文件):${hint}`);
    }
    lines = [...lines.slice(0, idx), ...newLines, ...lines.slice(idx + oldLines.length)];
    cursor = idx + newLines.length;
  }
  return lines.join('\n');
}
