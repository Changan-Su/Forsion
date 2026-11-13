/** Immutable, session-scoped spill files. New results are reduced once on ingestion;
 * history replays the stored preview verbatim instead of shrinking old messages. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getSessionDir, markSessionDirty } from '../sandbox/sessionSandbox.js';
import { anchoredRoot, mkdirConfined, readConfined, writeConfined } from '../sandbox/confinedFs.js';
import { tanguHome } from '../core/tanguHome.js';
import { estimateTokensRough, capToolResult } from '../services/contextBudget.js';
import type { ToolCapabilities, ToolContext } from './toolTypes.js';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function toolOutputTokenBudget(ctx: Pick<ToolContext, 'contextWindow'>): number {
  const window = Number(ctx.contextWindow);
  return Math.max(512, Math.min(2000, Math.floor((Number.isFinite(window) && window > 0 ? window : 200_000) * 0.01)));
}
function takeTokens(text: string, budget: number, tail = false): string {
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokensRough(tail ? text.slice(-mid) : text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return tail ? (lo ? text.slice(-lo) : '') : text.slice(0, lo);
}
function makePreview(text: string, budget: number): string {
  const available = Math.max(128, Math.floor(budget * 0.65) - 160);
  const head = takeTokens(text, Math.floor(available * 0.7));
  const tail = takeTokens(text, Math.floor(available * 0.3), true);
  return `${head}\n…[omitted ${text.length - head.length - tail.length} of ${text.length} characters]…\n${tail}`;
}
export function toolOutputWorkspaceKey(ctx: Pick<ToolContext, 'userId' | 'appId' | 'sessionId'>) {
  return { userId: ctx.userId, appId: ctx.appId, sessionId: ctx.sessionId, wsProject: null };
}
async function location(ctx: ToolContext, id: string): Promise<{ root: string; relative: string; display: string }> {
  if (!/^out-[a-f0-9]{64}$/.test(id)) throw new Error('Invalid tool output id');
  const scope = hash(JSON.stringify([ctx.userId, ctx.appId, ctx.sessionId]));
  const host = ctx.execMode === 'host';
  const base = host ? tanguHome() : await getSessionDir(toolOutputWorkspaceKey(ctx));
  if (host) await fs.mkdir(base, { recursive: true, mode: 0o700 });
  // Resolve an intentionally symlinked home once; the artifact subtree itself must
  // have no symlinks, and each confined IO is anchored at this session's directory.
  const realBase = await fs.realpath(base);
  const sub = `.agent/tool-outputs/${scope}`;
  await mkdirConfined(realBase, sub);
  const root = path.join(realBase, sub);
  if (await fs.realpath(root) !== root) throw new Error('Invalid artifact directory');
  const relative = `${id}.txt`;
  const file = path.join(root, relative);
  const stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat && !stat.isFile()) throw new Error('Invalid artifact file');
  return { root, relative, display: host ? file : `/${sub}/${relative}` };
}
export async function persistLargeOutput(ctx: ToolContext, _label: string, fullText: string): Promise<{ preview: string; path: string | null; id?: string }> {
  const budget = toolOutputTokenBudget(ctx);
  if (ctx.ptcRead || estimateTokensRough(fullText) <= budget) return { preview: fullText, path: null };
  const preview = makePreview(fullText, budget);
  try {
    if (Buffer.byteLength(fullText) > MAX_ARTIFACT_BYTES) throw new Error('output exceeds 16 MB artifact limit');
    const id = `out-${hash(fullText)}`;
    const loc = await location(ctx, id);
    const root = await anchoredRoot(loc.root);
    if (!root) throw new Error('artifact root unavailable');
    // Confined IO rejects symlinks and paths escaping the workspace. Equal content
    // has the same id; readers verify it, so tampering is reported instead of trusted.
    const existing = await readConfined(root, loc.relative, { maxBytes: MAX_ARTIFACT_BYTES });
    if (existing && hash(existing.toString('utf8')) !== hash(fullText)) throw new Error('Existing artifact has changed');
    if (!existing) await writeConfined(root, loc.relative, Buffer.from(fullText));
    if (ctx.execMode !== 'host') markSessionDirty(toolOutputWorkspaceKey(ctx));
    return { preview, path: loc.display, id };
  } catch {
    return { preview: `${preview}\n[Full output could not be saved. Narrow the original query or read its source in smaller ranges; this preview is incomplete.]`, path: null };
  }
}
export async function formatToolOutput(ctx: ToolContext, label: string, fullText: string, kind: ToolCapabilities['outputKind'] = 'data'): Promise<string> {
  // Skill loading is already an explicit on-demand read. Making its instructions
  // an optional preview can silently omit requirements before the model acts.
  // The loop checks its remaining context budget before admitting this result;
  // if the full instructions cannot fit, it returns a recoverable tool error.
  if (kind === 'instructions') return fullText;
  // Restricted tool loadouts must not receive a handle they cannot open.
  if (ctx.canReadToolOutput === false && !ctx.ptcRead) return capToolResult(fullText);
  const result = await persistLargeOutput(ctx, label, fullText);
  if (!result.path) return result.preview;
  return `${result.preview}\n\n[Full output: ${result.id}. Use read_tool_output({id:"${result.id}", offset:0, limit:4000, contains:"optional literal"}) to retrieve a range or matching lines.]`;
}
export async function readToolOutput(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const id = String(args.id || '');
  const loc = await location(ctx, id);
  const data = await readConfined(loc.root, loc.relative, { maxBytes: MAX_ARTIFACT_BYTES });
  if (!data) throw new Error('Tool output is missing or inaccessible in this session; rerun the original read');
  const full = data.toString('utf8');
  if (`out-${hash(full)}` !== id) throw new Error('Tool output integrity check failed; rerun the original read');
  const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 4000);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new Error('offset must be a nonnegative character index; limit must be 1–8000 characters');
  const pageLimit = ctx.ptcRead ? limit : Math.min(limit, Math.max(128, toolOutputTokenBudget(ctx) - 250));
  // Budget the wire representation: JSON escaping and per-match metadata can
  // exceed the raw text size, otherwise the loop would spill this page again.
  const budget = ctx.ptcRead ? Infinity : toolOutputTokenBudget(ctx) - 8;
  function fitLength(max: number, render: (length: number) => string): number {
    let lo = 0, hi = max;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokensRough(render(mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  const contains = args.contains === undefined ? '' : String(args.contains);
  if (contains.length > 256) throw new Error('contains must be a literal of at most 256 characters');
  if (contains) {
    const matches: { offset: number; text: string }[] = [];
    let cursor = Math.min(offset, full.length), chars = 0;
    while (cursor < full.length) {
      const end = full.indexOf('\n', cursor), stop = end < 0 ? full.length : end;
      const line = full.slice(cursor, stop);
      const lineStart = cursor > 0 ? full.lastIndexOf('\n', cursor - 1) + 1 : 0;
      if (full.slice(lineStart, stop).includes(contains)) {
        if (chars + line.length > pageLimit && matches.length) break;
        const length = fitLength(Math.min(line.length, pageLimit - chars), n => JSON.stringify({
          id, totalChars: full.length, matches: [...matches, { offset: cursor, text: line.slice(0, n) }], nextOffset: cursor + n,
        }));
        if (!length) break;
        matches.push({ offset: cursor, text: line.slice(0, length) });
        chars += length;
        if (length < line.length || chars >= pageLimit) { cursor += length; break; }
      }
      cursor = stop + (end < 0 ? 0 : 1);
    }
    return JSON.stringify({ id, totalChars: full.length, matches, nextOffset: cursor < full.length ? cursor : null });
  }
  const length = fitLength(Math.min(pageLimit, Math.max(0, full.length - offset)), n => JSON.stringify({
    id, totalChars: full.length, offset, nextOffset: offset + n, text: full.slice(offset, offset + n),
  }));
  const text = full.slice(offset, offset + length);
  return JSON.stringify({ id, totalChars: full.length, offset, nextOffset: offset + text.length < full.length ? offset + text.length : null, text });
}
