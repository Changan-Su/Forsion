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
      description: 'Post a remark to the team chat BEFORE you finish your turn: a blocking question, a heads-up during long work, or a handoff. Your final answer is posted to the team chat automatically, so do NOT use this to deliver your answer or report — just write it as your final message. After calling this, end your turn with just DONE unless you have something genuinely new to add — except when you set requestReply: then you are waiting for an answer, so end WITHOUT DONE. A remark repeated in your final answer is dropped. By default this only posts the remark; set requestReply=true with @name only when assigning new work or asking a question that needs a response. Never request a reply to thanks, completion announcements or acknowledgements. Private drafts and tool output stay in your own session.',
      parameters: { type: 'object', properties: {
        text: { type: 'string', description: 'The complete remark, in the user’s language.' },
        requestReply: { type: 'boolean', description: 'Activate @mentioned teammates to answer a question or do new work. Default false for progress, findings and completion acknowledgements.' },
      }, required: ['text'] },
    } },
    execute: async (args, ctx) => {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!ctx.sayToTeam) return 'Error: no active team chat.';
      if (!text || text.length > 16_000) return 'Error: text must contain 1–16000 characters.';
      const wantsReply = args.requestReply === true;
      await ctx.sayToTeam(text, wantsReply);
      // 等回答的那次绝不能建议写 DONE:写了就退出轮转,对方回来时它已经不在场了。
      return wantsReply
        ? 'Posted to the team chat; the mentioned teammate will be activated to answer. You are waiting on them — end your turn WITHOUT DONE so you come back when they reply, and do not repeat this remark (a repeat is dropped).'
        : 'Posted to the team chat. Your final answer is posted there too, so end your turn with just DONE unless you have something genuinely new — repeating this remark will be dropped.';
    },
  }],
};
