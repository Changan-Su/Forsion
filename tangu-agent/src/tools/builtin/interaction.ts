/**
 * 用户交互工具(类 Claude Code 的 AskUserQuestion / ExitPlanMode):
 *   - ask_user:run 中途向用户提问(选项 + 自由输入),经 inquiries 登记表等答案
 *   - exit_plan_mode:计划模式专用——提交计划求批准;批准则把会话 agent_config.planMode 关掉
 *     (本轮工具集已冻结仍保持只读,下一轮 run 起生效执行)
 * 仅本地形态(hostExec profile)暴露:云端前端(AI Studio)尚无询问 UI,暴露会让模型挂等。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deps } from '../../seams/runtime.js';
import { requestInquiry } from '../../services/inquiries.js';
import { publish } from '../../services/eventBus.js';
import type { ToolProvider } from '../toolRegistry.js';

const MAX_OPTIONS = 6;

/**
 * 「编辑后批准」的回传约定:answer = <原样的批准选项> + 本标记 + 用户改过的计划全文。
 * inquiry 通道只有一个字符串,故用标记追加——**选项字符串本身逐字不动**(TUI/旧客户端照旧能批)。
 */
export const PLAN_REVISION_MARK = '\n<<<REVISED_PLAN>>>\n';
/** 计划审阅的固定选项(顺序即客户端按钮顺序;「自动开始」在首位,类 Codex 的三选一)。 */
const PLAN_OPTIONS = [
  '批准,自动开始执行',
  '批准,退出计划模式(手动开始)',
  '需要修改(在输入框写反馈)',
  '拒绝,保持计划模式',
];

/** 两个「批准」选项(修订全文与自动开始都只认这两串逐字命中)。 */
const APPROVE_OPTIONS = [PLAN_OPTIONS[0], PLAN_OPTIONS[1]];
/** 自由文本批准:只认「就这一个词」的形态。**绝不能用前缀/子串判**——用户在打回框里写
 *  「批准前先补上回滚方案」「批准不了,先说清楚迁移」都是反对意见,前缀判会把它们当成批准
 *  (还可能因为含「自动开始」直接开跑)。否定式中文是这条的常态,不是边角。 */
const FREE_APPROVE_RE = /^(批准|同意|approve|approved|ok|yes|y)[!!。.]?$/i;

/** 解析计划审阅的答案。修订全文**只在头部逐字等于批准选项时**才认(自由文本恰好含标记不算)。 */
export function parsePlanAnswer(answer: string): {
  approved: boolean;
  autoStart: boolean;
  revised?: string;
  /** 回给模型的原文(未批准时用):无修订则为整串答案。 */
  raw: string;
} {
  const i = answer.indexOf(PLAN_REVISION_MARK);
  const head = (i >= 0 ? answer.slice(0, i) : answer).trim();
  const tail = i >= 0 ? answer.slice(i + PLAN_REVISION_MARK.length).trim() : '';
  const isApproveOption = APPROVE_OPTIONS.includes(head);
  const revised = tail && isApproveOption ? tail : undefined;
  const approved = isApproveOption || FREE_APPROVE_RE.test(head);
  return {
    approved,
    autoStart: head === PLAN_OPTIONS[0],
    revised,
    // 非批准的答案一律把**整串**交回模型(含标记后的正文:那可能就是用户的反馈全文)。
    raw: revised ? head : answer,
  };
}

export const interactionProvider: ToolProvider = {
  id: 'builtin:interaction',
  tools: () => [
    {
      name: 'ask_user',
      mode: 'both',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      definition: {
        type: 'function',
        function: {
          name: 'ask_user',
          description:
            'Ask the user a question and wait for an answer (optionally with candidate options; the user can also type freely). Only use this when **user decision is truly needed**: ' +
            'the requirement is ambiguous, multiple reasonable approaches need a trade-off, or an operation has broad impact and needs confirmation. Do not ask about things you can infer from context/code.',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The full question (end with a question mark, give enough context)' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: `Candidate options (may be empty; at most ${MAX_OPTIONS}, one sentence each; put the recommended one first)`,
              },
            },
            required: ['question'],
          },
        },
      },
      execute: async (args, ctx) => {
        const question = String(args.question ?? '').trim();
        if (!question) return 'Error: question is required';
        if (!ctx.runId) return 'Error: 无 run 上下文,无法询问用户';
        const options = (Array.isArray(args.options) ? args.options : [])
          .map((o: any) => String(o ?? '').trim())
          .filter(Boolean)
          .slice(0, MAX_OPTIONS);
        const answer = await requestInquiry(
          ctx.runId,
          { question, options, allowFreeText: true },
          ctx.signal,
        );
        return `用户回答:${answer}`;
      },
    },
    {
      name: 'exit_plan_mode',
      mode: 'both',
      // 仅计划模式可见(planMode 是 run 级配置,defs 每 run 冻结 → 可见性按 run 稳定)
      isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !!ctx.planMode,
      definition: {
        type: 'function',
        function: {
          name: 'exit_plan_mode',
          description:
            'Plan-mode only: once research is complete and the plan is formed, submit the **full plan** to the user for approval. ' +
            'Approved → plan mode turns off (write operations become executable starting from the next message); changes requested → refine the plan per feedback and submit again.',
          parameters: {
            type: 'object',
            properties: {
              plan: { type: 'string', description: 'The full implementation plan (markdown: goals/steps/files involved/how to verify)' },
            },
            required: ['plan'],
          },
        },
      },
      execute: async (args, ctx) => {
        const plan = String(args.plan ?? '').trim();
        if (!plan) return 'Error: plan is required';
        if (!ctx.runId) return 'Error: 无 run 上下文';
        // 计划全文走专用事件(客户端渲染计划卡;询问事件只带问题不重复带全文)
        void publish(ctx.runId, 'plan', { plan });
        const answer = await requestInquiry(
          ctx.runId,
          {
            question: '计划已就绪(见上方计划卡)。是否批准并退出计划模式?',
            // 批准后由客户端在本 run 结束时自动发起执行消息(本轮工具集已冻结只读,执行必须是新 run,
            // 引擎侧无法就地开工)。选项字符串是与客户端的 wire 约定,勿改字面。
            options: PLAN_OPTIONS,
            allowFreeText: true,
            kind: 'plan', // 客户端据此渲染专属计划卡(批准 / 编辑后批准 / 打回)
          },
          ctx.signal,
        );
        const verdict = parsePlanAnswer(answer);
        if (verdict.approved) {
          const autoStart = verdict.autoStart;
          const finalPlan = verdict.revised || plan;
          // 关掉会话的 planMode(读-改-写 agent_config;本轮 defs 已冻结仍只读,下一轮生效)
          try {
            const raw = await deps().state.getAgentConfig(ctx.sessionId);
            const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
            cfg.planMode = false;
            await deps().state.setAgentConfig(ctx.sessionId, JSON.stringify(cfg));
          } catch (e: any) {
            return `用户已批准,但关闭计划模式失败:${e?.message || e}(请手动关闭计划开关)`;
          }
          // 把批准的计划存盘(<cwd>/.tangu/plans/plan-<时间>.md;best-effort,失败不阻断退出)
          let planFile = '';
          try {
            const cwd = ctx.cwd || process.cwd();
            const d = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
            const dir = join(cwd, '.tangu', 'plans');
            await mkdir(dir, { recursive: true });
            planFile = join(dir, `plan-${ts}.md`);
            // 存档存**最终版**:用户改过就以用户那份为准,否则存档与要执行的东西不是一回事。
            await writeFile(planFile, finalPlan.endsWith('\n') ? finalPlan : `${finalPlan}\n`, 'utf8');
          } catch {
            planFile = '';
          }
          // auto 标志让客户端在本 run 结束后自动发起执行消息(desktop 监听 plan_approved)。
          void publish(ctx.runId, 'plan_approved', {
            ...(planFile ? { file: planFile } : {}),
            auto: autoStart,
            ...(verdict.revised ? { revised: true } : {}),
          });
          return (
            '用户已批准计划,计划模式已关闭。' +
            (planFile ? `计划已存档到 ${planFile}。` : '') +
            (verdict.revised
              ? `\n\n⚠️ 用户**修改了计划**,以下是最终版,一切以它为准(不要按你原来那份执行):\n\n${finalPlan}\n\n`
              : '') +
            '现在请用 todo_write 把计划拆成任务清单(便于跟踪进度),并简要总结收尾;' +
            '本轮工具集仍为只读,' +
            (autoStart ? '收尾后将自动开始执行(无需等用户确认)。' : '用户的下一条消息将开始执行。')
          );
        }
        return `用户未批准:${verdict.raw}\n请按反馈完善计划,再次调用 exit_plan_mode 提交。`;
      },
    },
  ],
};
