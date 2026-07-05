/**
 * 把一段 agent 回复切成多条「像真人聊天」的消息(拟人分段回复用;经 services/replySegment 供各通道调用)。
 * 策略:含代码块/表格不拆;按行(自然边界)切,过长的行再按句末标点切;段数封顶并回末段防刷屏。
 * 纯函数,无副作用 —— 便于自检(见 splitMessage.test.ts)。
 */
const MAX_SEG = 160; // 单段目标上限(中文 IM 习惯)
const HARD_MAX = 600; // 绝不超过(无标点长句兜底硬切)
const MAX_SEGMENTS = 8; // 段数封顶,超出并回末段

/** 仅当两侧都是 ASCII 词/标点时,拼接句子需补空格(中文不补)。 */
function needsSpace(a: string, b: string): boolean {
  return /[A-Za-z0-9.,!?)\]]$/.test(a) && /^[A-Za-z0-9([]/.test(b);
}

export function splitMessage(text: string, opts?: { maxSeg?: number; maxSegments?: number }): string[] {
  const maxSeg = opts?.maxSeg ?? MAX_SEG;
  const maxSegments = opts?.maxSegments ?? MAX_SEGMENTS;
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (t.includes('```') || t.includes('\n|')) return [t]; // 代码块/markdown 表格不拆

  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const units: string[] = [];
  for (const line of lines) {
    if (line.length <= maxSeg) { units.push(line); continue; }
    // 长行按句末标点(中英)切,累积到接近 maxSeg 即断。
    const sentences = line.match(/[^。！？!?.]*[。！？!?.]+|[^。！？!?.]+/g) || [line];
    let buf = '';
    for (const s of sentences) {
      const piece = s.trim();
      if (!piece) continue;
      if (buf && buf.length + piece.length + 1 > maxSeg) { units.push(buf); buf = piece; }
      else buf = buf ? `${buf}${needsSpace(buf, piece) ? ' ' : ''}${piece}` : piece;
      while (buf.length > HARD_MAX) { units.push(buf.slice(0, HARD_MAX)); buf = buf.slice(HARD_MAX); }
    }
    if (buf) units.push(buf);
  }
  if (units.length > maxSegments) {
    return [...units.slice(0, maxSegments - 1), units.slice(maxSegments - 1).join('\n')];
  }
  return units.length ? units : [t];
}

/** 段间拟人延迟:基础 + 按下一段长度(打字耗时),带轻微抖动,封顶 3.5s。 */
export function segmentDelayMs(nextSeg: string, baseMs = 450): number {
  const typing = Math.min(nextSeg.length * 28, 2500);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(baseMs + typing + jitter, 3500);
}
