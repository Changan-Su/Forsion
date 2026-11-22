/**
 * set_automation_suggestions —— Muse 设定自动化首页上的任务建议(最多 6 条,整组替换)。实现与规矩见 services/museAutomationSuggestions.ts。
 * 可见性:仅 Muse run(ctx.muse)、本机能跑自动化(hostExec)且 muse.automationSuggestions 开着;列入 PLAN_MODE_TOOLS(只是向用户提议,不建规则、不碰用户资产)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { loadSpecialAgentsConfig } from '../../services/specialAgentsConfig.js';
import { MAX_SUGGESTIONS, SUGGESTION_SOURCE_KINDS, setSuggestions, validateSuggestions } from '../../services/museAutomationSuggestions.js';

const suggestionsOn = (): boolean => {
  try { return loadSpecialAgentsConfig().muse.automationSuggestions; } catch { return true; }
};

export const museAutomationSuggestionsProvider: ToolProvider = {
  id: 'builtin:set_automation_suggestions',
  tools: () => [
    {
      name: 'set_automation_suggestions',
      mode: 'both',
      isEnabledFor: (profile, ctx) => !!(ctx as any).muse && !!profile.capabilities.hostExec && suggestionsOn(),
      definition: {
        type: 'function',
        function: {
          name: 'set_automation_suggestions',
          description:
            `Set the task suggestions shown on the user's Automation home page (at most ${MAX_SUGGESTIONS}). This replaces the whole set: ` +
            'pass the ones you want to keep exactly as they are and they stay put; pass an empty list to clear. ' +
            'Each suggestion is a repeat task the user could hand to an automation rule, grounded in something you actually saw them do by hand ' +
            '(e.g. they tidy the dev log every Monday morning, write the meeting agenda right before a weekly event, tag every new row of a database, sit in one app for hours). ' +
            'Nothing is created: the user opens it as a draft in the workflow canvas, edits it and saves it themselves. ' +
            'Write title and why in the user\'s language. title: the task in a few words. why: one sentence on what you saw. ' +
            'source names that evidence (the app shows label as a link; note and database need ref = the file path you read). ' +
            'rule takes the same fields as manage_automation set (cond_type, its parameters, actions, only, …); use only triggers and actions that tool offers, and no tool_call steps. ' +
            'For a weekly task use daily_at with only.weekdays (e.g. Monday = [1]). An agent_run step may leave agentSlug empty: the user picks the agent when they open the draft. ' +
            'Do not repeat a rule the user already has, a rule card waiting in your direct chat, or one of your todos. ' +
            'Keep a suggestion until it stops being relevant — swapping them every cycle makes the page jumpy.',
          parameters: {
            type: 'object',
            properties: {
              suggestions: {
                type: 'array',
                maxItems: MAX_SUGGESTIONS,
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: 'The task in a few words, e.g. "Sort new feedback rows"' },
                    why: { type: 'string', description: 'One sentence: what you saw that makes this worth automating' },
                    source: {
                      type: 'object',
                      properties: {
                        kind: { type: 'string', enum: [...SUGGESTION_SOURCE_KINDS] },
                        label: { type: 'string', description: 'Short name of the evidence: the note, event, database, app or todo list' },
                        ref: { type: 'string', description: 'note / database: the file path (absolute, or relative to the notes vault); calendar: the date (YYYY-MM-DD); otherwise omit' },
                      },
                      required: ['kind', 'label'],
                    },
                    rule: { type: 'object', description: 'The draft rule: the same fields as manage_automation set (desc defaults to title)' },
                  },
                  required: ['title', 'why', 'source', 'rule'],
                },
              },
            },
            required: ['suggestions'],
          },
        },
      },
      execute: async (args, ctx) => {
        const v = validateSuggestions(args.suggestions, { cwd: ctx.cwd });
        if ('error' in v) return `Error: ${v.error}. Nothing was changed.`;
        try {
          const { shown, refused } = await setSuggestions(ctx.userId, v.suggestions);
          const now = shown.length ? `Now shown on the Automation page: ${shown.map((s) => `"${s.title}"`).join('; ')}.` : 'No automation suggestions are shown now.';
          return refused.length ? `${now} Not added because the user dismissed them recently: ${refused.map((t) => `"${t}"`).join('; ')}.` : now;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
