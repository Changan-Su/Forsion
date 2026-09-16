import type { ToolProvider } from '../toolRegistry.js';

/** Explicit public remarks; private drafts and tool output remain in the member session. */
export const teamSayProvider: ToolProvider = {
  id: 'builtin:team-say',
  tools: () => [{
    name: 'team_say', mode: 'both',
    isEnabledFor: (_profile, ctx) => !!ctx.teamSessionId && !(ctx.subAgentDepth && ctx.subAgentDepth > 0),
    capabilities: { sideEffect: 'none', parallel: false },
    definition: { type: 'function', function: {
      name: 'team_say',
      description: 'Post a concise public remark to the team chat now, while continuing your work. Use for progress, findings, questions or handoffs. By default this only posts the remark; set requestReply=true with @name only when assigning new work or asking a question that needs a response. Never request a reply to thanks, completion announcements or acknowledgements. Private drafts and tool output stay in your own session. Do not repeat a posted remark in your final answer.',
      parameters: { type: 'object', properties: {
        text: { type: 'string', description: 'The complete remark, in the user’s language.' },
        requestReply: { type: 'boolean', description: 'Activate @mentioned teammates to answer a question or do new work. Default false for progress, findings and completion acknowledgements.' },
      }, required: ['text'] },
    } },
    execute: async (args, ctx) => {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!ctx.sayToTeam) return 'Error: no active team chat.';
      if (!text || text.length > 16_000) return 'Error: text must contain 1–16000 characters.';
      await ctx.sayToTeam(text, args.requestReply === true);
      return 'Posted to the team chat. Continue your work; do not repeat this remark.';
    },
  }],
};
