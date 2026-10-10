import type { ToolProvider } from '../toolRegistry.js';
import { currentDisplayAgentSlug } from '../../seams/runContext.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { HUMAN_WRITING, readHuman, removedLines, writeHuman, type HumanScope } from '../../agents/humanStore.js';
import { humanProjectScope } from '../../services/humanContext.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../../services/agentFileSync.js';
import { deps } from '../../seams/runtime.js';
import { memoryLogProvider, REMEMBER_FACT_MAX_CHARS } from './memoryLog.js';
import type { ToolContext } from '../toolTypes.js';

// 模型得把读到的版本号原样抄回来。64 位十六进制它偶尔抄漏几位(10-10 实测 gpt-6-luna:10 轮里有 1 轮连着两次抄漏,那次保存报了冲突、没存上)。
// 交给它的只有前 12 位;回来的恰好是这 12 位十六进制、又对得上当前版本时才换成完整版本,别的写法(含完整版本号)原样交下去逐字比对。
// 落盘那道比对(writeHuman 的 expectedVersion)照旧用完整版本。
const SHORT_VERSION = 12;

// ── 改写时被拿掉的行:逐行交代去向,交代全了才存 ──
// 10-10 实测 gpt-6-luna:请它「整理一下」,它把自己的承诺从说明里删了却不记 —— 只存在说明里的那条用户要求,6 轮里 4 轮两边都没有了。
// 把「先记下再拿掉」说进请求里:两种说法合计 6 轮里 4 轮记全(它记的是和眼前的事有关的几条);把拿掉的行放进回执里请它补记:它补了相关的,无关的那条照样漏。
// 所以改成结构上不靠它自觉:拿掉了行的写入先不存,把这些行编号交回;它得逐行说去向(memory / reworded / dropped),说全了才存,
// 归 memory 的那句由这里直接记进记忆(走 remember 的同一条路:长度、去重、写满的处理都一样),不指望它自己另调一次。
// 分不出的那部分仍靠它判断(把自己的承诺标成 reworded / dropped):台架 `--only humanreal --humanreal-legacy` 量的就是这个。
type Disposition = { to: 'memory' | 'reworded' | 'dropped'; fact?: string };
const PENDING = 'Nothing was saved yet. This update takes the numbered lines in `removed` out of the note. Resend the same update (same content, summary, evidence and expectedVersion) with `removed`: one string per line number, saying where the line went. "<n> memory: <one sentence>" when the line says what you will do or how the human wants you to work: it may be the only record of something they asked of you, so it must not be lost, whether or not it relates to the current task. The sentence (at most 300 characters, in the human\'s language) is saved to your memory by this tool; do not also call remember for it. "<n> reworded" when its point is still in the note in other words. "<n> dropped" when the human no longer needs it; for a line about what you will do, only if the human told you to forget it.';
function readDispositions(given: unknown, lines: number[]): { byLine: Map<number, Disposition>; problems: string[] } {
  const byLine = new Map<number, Disposition>(); const problems: string[] = [];
  for (const raw of Array.isArray(given) ? given : []) {
    const m = typeof raw === 'string' ? raw.trim().match(/^(\d+)\s*[:.)]?\s*(memory|reworded|dropped)\b\s*[:：-]?\s*([\s\S]*)$/i) : null;
    const n = m ? Number(m[1]) : 0;
    if (!m) { problems.push(`Not understood: ${JSON.stringify(raw).slice(0, 80)}`); continue; }
    if (!lines.includes(n)) continue; // 这一行这次没被拿掉(第二次交上来的内容把它留下了):多说的不算错
    const to = m[2].toLowerCase() as Disposition['to']; const fact = m[3].trim();
    if (to === 'memory' && !fact) problems.push(`Line ${n}: "memory" needs the sentence to save.`);
    else if (to === 'memory' && fact.length > REMEMBER_FACT_MAX_CHARS) problems.push(`Line ${n}: the sentence is ${fact.length} characters; at most ${REMEMBER_FACT_MAX_CHARS}.`);
    else byLine.set(n, to === 'memory' ? { to, fact } : { to });
  }
  for (const n of lines) if (!byLine.has(n) && !problems.some((p) => p.startsWith(`Line ${n}:`))) problems.push(`Line ${n}: not accounted for.`);
  return { byLine, problems };
}
const rememberFact = async (fact: string, scope: HumanScope, ctx: ToolContext): Promise<string> =>
  memoryLogProvider.tools().find((x) => x.name === 'remember')!.execute({ action: 'add', fact, scope: scope.kind }, ctx);

export const manageHumanProvider: ToolProvider = {
  id: 'builtin:manage_human', tools: () => [{
    // Collaboration feedback can arrive on any turn. Keep the schema available
    // across runs instead of requiring a second discovery step after each reply.
    name: 'manage_human',
    // Like local memory, Agent scope also works in projectless Chat (sandbox execution).
    isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !ctx.ephemeral && !ctx.planMode && !effectiveRemote(ctx) && !ctx.subAgentDepth,
    capabilities: { sideEffect: 'write', concurrencyKey: 'human-collaboration' },
    definition: { type: 'function', function: {
      name: 'manage_human',
      description: 'Read or update HUMAN.md, the note you write to the human about what THEY can do so that working with you goes better (they see it as the collaboration handbook). First read to obtain content and version, then update with the full revised Markdown and expectedVersion. Changes are applied immediately; the user receives a card and may edit or undo. Scope project is only for this project; scope agent is for advice that remains useful outside it. Preserve user edits. If an update takes existing lines out, the tool first lists them and saves nothing: resend with removed saying where each went. ' + HUMAN_WRITING + ' Use specific evidence; avoid personality judgments, permissions, transient tool failures and unsolicited homework. Keep it concise; batch related changes. Never write this file using generic file or shell tools.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'update'] }, scope: { type: 'string', enum: ['agent', 'project'] },
        content: { type: 'string', description: 'The complete updated Markdown, written to the human in their language; at most 12000 characters. Preserve unrelated sections.' },
        expectedVersion: { type: 'string', description: 'Exact version from the most recent read.' },
        summary: { type: 'string', description: 'Shown to the user on the change card: what changed, in their language and everyday words (at most 240 characters).' },
        evidence: { type: 'string', description: 'Shown to the user as the reason: what happened in your work together that shows this would help them, in their language and everyday words (at most 600 characters).' },
        removed: { type: 'array', items: { type: 'string' }, description: 'Only after the tool listed lines your update takes out: one string per line number, "<n> memory: <sentence to save>", "<n> reworded" or "<n> dropped".' },
      }, required: ['action', 'scope'] },
    } },
    execute: async (args, ctx) => {
      if (!deps().profile.capabilities.hostExec || ctx.ephemeral || ctx.planMode || ctx.subAgentDepth || effectiveRemote(ctx)) return 'Error: Collaboration updates are unavailable in this execution context.';
      try {
        if (!['agent', 'project'].includes(args.scope) || !['read', 'update'].includes(args.action)) return 'Error: Invalid action or scope.';
        const scope: HumanScope | null = args.scope === 'project' ? await humanProjectScope(ctx.userId, ctx.sessionId)
          : { kind: 'agent', slug: currentDisplayAgentSlug() || ctx.agentSlug || DEFAULT_AGENT_SLUG };
        if (!scope) return 'Error: This session has no project. Use agent scope only for collaboration that is useful outside a project.';
        const current = await readHuman(scope);
        if (args.action === 'read') return JSON.stringify({ ...current, version: current.version.slice(0, SHORT_VERSION), howToWrite: HUMAN_WRITING }); // 写法放在动笔前刚读到的地方
        ctx.signal?.throwIfAborted();
        const given: unknown = args.expectedVersion;
        const expectedVersion = typeof given === 'string' && given.length === SHORT_VERSION && /^[a-f0-9]+$/.test(given) && current.version.startsWith(given) ? current.version : given;
        // 版本对不上、或缺摘要 / 依据的,交给下面的落盘去拒(它给的报错更对路,也免得先记了记忆后面又存不上);其余的拿掉了行就先过交代这一关
        const complete = [args.content, args.summary, args.evidence].every((v) => typeof v === 'string') && !!args.summary.trim() && !!args.evidence.trim();
        const taken = complete && expectedVersion === current.version ? removedLines(current.content, args.content) : [];
        const text = new Map(taken.map((x) => [x.line, x.text]));
        const { byLine, problems } = readDispositions(args.removed, taken.map((x) => x.line));
        const pending = (extra: string[] = []) => JSON.stringify({ kind: 'human_pending', saved: false, removed: taken,
          ...(args.removed !== undefined || extra.length ? { problems: [...problems, ...extra] } : {}), message: PENDING });
        if (taken.length && problems.length) return pending();
        const moved: Array<{ line: string; fact: string }> = [];
        for (const [n, d] of byLine) {
          if (d.to !== 'memory') continue;
          const receipt = await rememberFact(d.fact!, scope, ctx);
          if (/^Error\b/.test(receipt) || receipt.includes('未写入')) return pending([`Line ${n}: could not be saved to memory (${receipt.slice(0, 300)}). Nothing was changed in the note.`]);
          moved.push({ line: text.get(n)!, fact: d.fact! });
        }
        const dropped = [...byLine].filter(([, d]) => d.to === 'dropped').map(([n]) => text.get(n)!);
        const result = await writeHuman(scope, { content: args.content, summary: args.summary, evidence: args.evidence, expectedVersion }, 'agent');
        // 不带 slug 是空操作;带的是归属(显示)agent —— HUMAN.md 跟着它的定义文件一起同步,不进记忆桶。
        if (scope.kind === 'agent' && result.change) scheduleAgentFilesSync(ctx.userId, scope.slug);
        return JSON.stringify({ kind: 'human_update', change: result.change, version: result.document.version.slice(0, SHORT_VERSION),
          message: result.change ? 'Applied immediately. The next run will read this version. The user can edit or undo from the update card.' : 'No change; the content is already current.',
          ...(moved.length || dropped.length ? { moved, dropped, next: 'Tell the human, in their own words, which lines you moved to your memory and which you dropped.' } : {}) });
      } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    },
  }],
};
