import type { ToolProvider } from '../toolRegistry.js';
import { currentDisplayAgentSlug } from '../../seams/runContext.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { readHuman, writeHuman, type HumanScope } from '../../agents/humanStore.js';
import { humanProjectScope } from '../../services/humanContext.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../../services/agentFileSync.js';
import { deps } from '../../seams/runtime.js';

export const manageHumanProvider: ToolProvider = {
  id: 'builtin:manage_human', tools: () => [{
    name: 'manage_human', deferred: true,
    deferHint: 'Read or improve HUMAN.md: how you and the human collaborate, their needed input, and optional learning. Updates take effect immediately with an undo card.',
    // Like local memory, Agent scope also works in projectless Chat (sandbox execution).
    isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !ctx.ephemeral && !ctx.planMode && !effectiveRemote(ctx) && !ctx.subAgentDepth,
    capabilities: { sideEffect: 'write', concurrencyKey: 'human-collaboration' },
    definition: { type: 'function', function: {
      name: 'manage_human',
      description: 'Read or update the human collaboration document HUMAN.md. First read to obtain content and version, then update with the full revised Markdown and expectedVersion. Changes are applied immediately; the user receives a card and may edit or undo. Scope project is only for this project; scope agent is for collaboration that remains useful outside it. Preserve user edits. Record your own adjustments, concrete input the human can contribute, and optional learning tied to a goal. Use specific evidence; avoid personality judgments, permissions, transient tool failures and unsolicited homework. Keep it concise; batch related changes. Never write this file using generic file or shell tools.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'update'] }, scope: { type: 'string', enum: ['agent', 'project'] },
        content: { type: 'string', description: 'The complete updated Markdown; at most 12000 characters. Preserve unrelated sections.' },
        expectedVersion: { type: 'string', description: 'Exact version from the most recent read.' },
        summary: { type: 'string', description: 'User-facing description of what changed, in the user language (at most 240 characters).' },
        evidence: { type: 'string', description: 'Specific feedback or observed friction supporting the change (at most 600 characters).' },
      }, required: ['action', 'scope'] },
    } },
    execute: async (args, ctx) => {
      if (!deps().profile.capabilities.hostExec || ctx.ephemeral || ctx.planMode || ctx.subAgentDepth || effectiveRemote(ctx)) return 'Error: Collaboration updates are unavailable in this execution context.';
      try {
        if (!['agent', 'project'].includes(args.scope) || !['read', 'update'].includes(args.action)) return 'Error: Invalid action or scope.';
        const scope: HumanScope | null = args.scope === 'project' ? await humanProjectScope(ctx.userId, ctx.sessionId)
          : { kind: 'agent', slug: currentDisplayAgentSlug() || ctx.agentSlug || DEFAULT_AGENT_SLUG };
        if (!scope) return 'Error: This session has no project. Use agent scope only for collaboration that is useful outside a project.';
        if (args.action === 'read') return JSON.stringify(await readHuman(scope));
        ctx.signal?.throwIfAborted();
        const result = await writeHuman(scope, { content: args.content, summary: args.summary, evidence: args.evidence, expectedVersion: args.expectedVersion }, 'agent');
        if (scope.kind === 'agent' && result.change) scheduleAgentFilesSync(ctx.userId);
        return JSON.stringify({ kind: 'human_update', change: result.change, version: result.document.version,
          message: result.change ? 'Applied immediately. The next run will read this version. The user can edit or undo from the update card.' : 'No change; the content is already current.' });
      } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    },
  }],
};
