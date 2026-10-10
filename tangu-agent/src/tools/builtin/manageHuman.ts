import type { ToolProvider } from '../toolRegistry.js';
import { currentDisplayAgentSlug } from '../../seams/runContext.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { HUMAN_WRITING, readHuman, removedLines, writeHuman, type HumanScope } from '../../agents/humanStore.js';
import { humanProjectScope } from '../../services/humanContext.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../../services/agentFileSync.js';
import { deps } from '../../seams/runtime.js';

// 模型得把读到的版本号原样抄回来。64 位十六进制它偶尔抄漏几位(10-10 实测 gpt-6-luna:10 轮里有 1 轮连着两次抄漏,那次保存报了冲突、没存上)。
// 交给它的只有前 12 位;回来的恰好是这 12 位十六进制、又对得上当前版本时才换成完整版本,别的写法(含完整版本号)原样交下去逐字比对。
// 落盘那道比对(writeHuman 的 expectedVersion)照旧用完整版本。
const SHORT_VERSION = 12;

// 改写时被拿掉的行原样交回(10-10 实测 gpt-6-luna:请它「整理一下」,它把自己的承诺从说明里删了却不记,6 轮里 4 轮
// 那条只存在说明里的用户要求两边都没有了;把「先记下再拿掉」说进请求里也只有 3 轮里 1 轮记全 —— 它记的是和眼前的事有关的几条)。
// 放在回执里而不是工具说明里:这是它刚做完、马上要接着处理的地方,也不让系统提示再变长。交回去的是原话,它不用自己回想删了什么。
const REMOVED_NEXT = 'These lines are no longer in the note. A line that says what you will do, or how the human wants you to work, may be the only record of something they asked of you: save every such line with remember now, before you reply, whether or not it relates to the current task. A line whose point is still in the note in other words needs nothing. Then tell the human which you moved to memory and which you dropped.';

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
      description: 'Read or update HUMAN.md, the note you write to the human about what THEY can do so that working with you goes better (they see it as the collaboration handbook). First read to obtain content and version, then update with the full revised Markdown and expectedVersion. Changes are applied immediately; the user receives a card and may edit or undo. Scope project is only for this project; scope agent is for advice that remains useful outside it. Preserve user edits. ' + HUMAN_WRITING + ' Use specific evidence; avoid personality judgments, permissions, transient tool failures and unsolicited homework. Keep it concise; batch related changes. Never write this file using generic file or shell tools.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'update'] }, scope: { type: 'string', enum: ['agent', 'project'] },
        content: { type: 'string', description: 'The complete updated Markdown, written to the human in their language; at most 12000 characters. Preserve unrelated sections.' },
        expectedVersion: { type: 'string', description: 'Exact version from the most recent read.' },
        summary: { type: 'string', description: 'Shown to the user on the change card: what changed, in their language and everyday words (at most 240 characters).' },
        evidence: { type: 'string', description: 'Shown to the user as the reason: what happened in your work together that shows this would help them, in their language and everyday words (at most 600 characters).' },
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
        const result = await writeHuman(scope, { content: args.content, summary: args.summary, evidence: args.evidence, expectedVersion }, 'agent');
        // 不带 slug 是空操作;带的是归属(显示)agent —— HUMAN.md 跟着它的定义文件一起同步,不进记忆桶。
        if (scope.kind === 'agent' && result.change) scheduleAgentFilesSync(ctx.userId, scope.slug);
        const removed = result.change ? removedLines(current.content, result.document.content) : [];
        return JSON.stringify({ kind: 'human_update', change: result.change, version: result.document.version.slice(0, SHORT_VERSION),
          message: result.change ? 'Applied immediately. The next run will read this version. The user can edit or undo from the update card.' : 'No change; the content is already current.',
          ...(removed.length ? { removed, next: REMOVED_NEXT } : {}) });
      } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    },
  }],
};
