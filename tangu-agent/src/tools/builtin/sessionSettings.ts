/**
 * session_settings / update_session_settings —— 让 agent 按用户的自然语言(「切到 opus」「想深一点」)
 * 或自己的判断改本会话的模型与思考档。通道(微信 / TG / QQ)里没有药丸可点,这是用户改设置最顺手的路。
 *
 * 安全口径(Codex / Hermes / DSH 三家一致:模型只能申请,不能改策略):
 *   - **审批档绝不开放**:`approve_always` 按裸工具名放行,批一次「切模型」若连带能改档,等于把提权开关交出去。
 *   - 写工具 capabilities.approval:'command' —— 询问我批准 / 替我批准 档逐次弹审批,完全放行档自动过。
 *   - 读工具零副作用、不过闸(否则「看一眼有哪些模型」也要用户点头)。
 *   - 子代理 / 讨论 / 团队成员 / Muse / 自动化 一律不可见:它们没有「用户这轮说要换」的前提,且改的是别人的会话。
 * 生效时机:模型 = 下一个 run(本轮回复仍是旧模型);思考档 = 本 run 下一次请求起(loop 在迭代边界取走覆盖值)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { publish } from '../../services/eventBus.js';
import { chatModels, effectiveThinkingOn, listModelCatalog, resolveModelQuery, type CatalogModel } from '../../services/modelCatalog.js';
import { patchSessionAgentConfig, readSessionSettings, requestRunThinking, setSessionModelId } from '../../services/sessionSettings.js';
import { THINKING_LEVELS, normalizeThinkingLevel, type ThinkingLevel } from '../../llm/modelCapabilities.js';
import { deps } from '../../seams/runtime.js';

/** 只给「人在这轮对话里」的前台 run:子代理、讨论 / 团队成员、Muse、自动化都没有这个前提。 */
function enabledFor(_p: unknown, ctx: ToolContext): boolean {
  return !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.inDiscussion && !ctx.muse && !ctx.automationOrigin && !ctx.ephemeral && !ctx.approvalDeferral;
}

const MAX_LISTED = 60;
const line = (m: CatalogModel, cur: string): string =>
  `${m.id === cur ? '* ' : '- '}${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ''}${m.thinkingLevels?.length ? ` — thinking: ${m.thinkingLevels.join('/')}` : ''}`;

async function catalogFor(ctx: ToolContext): Promise<CatalogModel[]> {
  return chatModels((await listModelCatalog(ctx.profile ?? deps().profile)).models);
}

export const sessionSettingsProvider: ToolProvider = {
  id: 'builtin:session_settings',
  tools: () => [
    {
      name: 'session_settings',
      mode: 'host',
      deferred: true,
      deferGroup: 'session_settings',
      deferHint: "Read or change this conversation's model and thinking level (when the user asks to switch model / think harder, or the task needs it).",
      isEnabledFor: enabledFor,
      definition: {
        type: 'function',
        function: {
          name: 'session_settings',
          description:
            "Read this conversation's current settings: model, requested thinking level and what it runs as on this model, approval mode, and the models you can switch to (* marks the current one). " +
            'Read-only. Call it before update_session_settings when you are unsure of the exact model id.',
          parameters: {
            type: 'object',
            properties: {
              include_models: { type: 'boolean', description: 'List switchable models (default true)' },
            },
          },
        },
      },
      execute: async (args, ctx) => {
        const models = await catalogFor(ctx);
        const cur = ctx.modelId || '';
        const curModel = models.find((m) => m.id === cur);
        const requested = normalizeThinkingLevel(ctx.thinkingLevel);
        const out = [
          `Model: ${cur || '(unknown)'}${curModel && curModel.name !== cur ? ` (${curModel.name})` : ''}`,
          `Thinking level: ${requested}${curModel?.thinkingLevels?.length ? ` (runs as ${effectiveThinkingOn(requested, curModel.thinkingLevels)} on this model; supported: ${curModel.thinkingLevels.join('/')})` : ''}`,
          `Approval mode: ${ctx.approvalMode || 'full-auto'} (only the user can change it)`,
        ];
        if (args?.include_models !== false) {
          out.push('', `Models (${models.length}${models.length > MAX_LISTED ? `, first ${MAX_LISTED}` : ''}):`);
          for (const m of models.slice(0, MAX_LISTED)) out.push(line(m, cur));
          if (!models.length) out.push('(none available — the model catalog is empty or unreachable)');
        }
        return out.join('\n');
      },
    },
    {
      name: 'update_session_settings',
      mode: 'host',
      deferred: true,
      deferGroup: 'session_settings',
      deferHint: "Switch this conversation's model or thinking level (needs the user's approval unless they granted full access).",
      isEnabledFor: enabledFor,
      capabilities: { approval: 'command' }, // 询问我批准 / 替我批准 逐次审批;完全放行自动过(用户口径)
      definition: {
        type: 'function',
        function: {
          name: 'update_session_settings',
          description:
            "Change this conversation's model and/or thinking level. Use when the user asks for it (e.g. \"switch to opus\", \"think harder\"), or when the task clearly needs a stronger / cheaper setting — then say why in `reason`, the user sees it on the approval prompt. " +
            'The model may be a partial name; an ambiguous or unknown name changes nothing and returns the candidates. ' +
            'A model change takes effect after your current reply finishes (the reply itself still runs on the current model); a thinking-level change applies from your next request. ' +
            'The approval mode cannot be changed with this tool — tell the user to change it themselves.',
          parameters: {
            type: 'object',
            properties: {
              model: { type: 'string', description: 'Model id or name (partial is fine, e.g. "opus" or "codex/gpt-5.6-luna")' },
              thinking_level: { type: 'string', enum: [...THINKING_LEVELS], description: 'Thinking level; unsupported levels run as the nearest supported one' },
              reason: { type: 'string', description: 'One short sentence shown to the user on the approval prompt' },
            },
            required: ['reason'],
          },
        },
      },
      execute: async (args, ctx) => {
        const wantModel = typeof args?.model === 'string' ? args.model.trim() : '';
        const rawLevel = typeof args?.thinking_level === 'string' ? args.thinking_level.trim() : '';
        if (!wantModel && !rawLevel) return 'Error: give `model` and/or `thinking_level`.';
        const level: ThinkingLevel | undefined = rawLevel ? normalizeThinkingLevel(rawLevel, 'off') : undefined;
        // 两个不同的兜底值归一出同一档 = 认得这个写法(none/ultra 等别名也收);认不得就报错,不静默落到兜底档。
        if (rawLevel && level !== normalizeThinkingLevel(rawLevel, 'max'))
          return `Error: unknown thinking level "${rawLevel}". Use one of: ${THINKING_LEVELS.join(', ')}.`;

        const models = await catalogFor(ctx);
        let target: CatalogModel | undefined;
        if (wantModel) {
          const hit = resolveModelQuery(wantModel, models);
          if (hit.kind === 'ambiguous')
            return `Nothing changed: "${wantModel}" matches several models — ask the user which one, or retry with an exact id:\n${hit.candidates.slice(0, 15).map((m) => `- ${m.id}${m.name !== m.id ? ` (${m.name})` : ''}`).join('\n')}`;
          if (hit.kind === 'none')
            return `Nothing changed: no model matches "${wantModel}". Call session_settings to see the available models.`;
          target = hit.model;
        }

        const notes: string[] = [];
        const changed: { modelId?: string; thinkingLevel?: ThinkingLevel } = {};
        if (target) {
          // 比「会话此刻存的」而不是 run 启动时的 ctx.modelId:同一个 run 里切了两次(A→B→A)时,第二次按 ctx 会误报「已是 A」而库里留着 B。
          const stored = (await readSessionSettings(ctx.sessionId, ctx.userId))?.modelId || ctx.modelId;
          if (target.id === stored) notes.push(`Model is already ${target.id}.`);
          else {
            await setSessionModelId(ctx.sessionId, ctx.userId, target.id);
            changed.modelId = target.id;
            notes.push(`Model set to ${target.id}; it takes effect after this reply finishes (this reply, and anything the user adds while it runs, still uses ${ctx.modelId || 'the current model'}).`);
          }
        }
        if (level) {
          await patchSessionAgentConfig(ctx.sessionId, { thinkingLevel: level });
          if (ctx.runId) requestRunThinking(ctx.runId, level);
          changed.thinkingLevel = level;
          const onModel = target ?? models.find((m) => m.id === ctx.modelId);
          const eff = effectiveThinkingOn(level, onModel?.thinkingLevels);
          notes.push(`Thinking level set to ${level}${eff !== level ? ` (runs as ${eff} on ${onModel?.id})` : ''}; it applies from your next request.`);
        }
        // 桌面 / TUI 用自己缓存的配置起 run —— 不通知它们,下一轮就把刚写的值盖回去。
        if (ctx.runId && (changed.modelId || changed.thinkingLevel)) {
          void publish(ctx.runId, 'session_config_changed', { sessionId: ctx.sessionId, ...changed, source: 'agent' });
        }
        return notes.join('\n');
      },
    },
  ],
};
