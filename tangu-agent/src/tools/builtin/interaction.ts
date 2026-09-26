/**
 * 用户交互工具(类 Claude Code 的 AskUserQuestion / ExitPlanMode):
 *   - ask_user:run 中途向用户提问(选项 + 自由输入),经 inquiries 登记表等答案
 *   - exit_plan_mode:计划模式专用——提交计划求批准;批准则把会话 agent_config.planMode 关掉
 *     (本轮工具集已冻结仍保持只读,下一轮 run 起生效执行)
 * 仅本地形态(hostExec profile)暴露:云端前端(AI Studio)尚无询问 UI,暴露会让模型挂等。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_NAME } from '../../core/tanguHome.js';
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

/**
 * 系统代答(不是用户本人的回答)的约定前缀:下面两句系统说明都以它开头,模型一眼看得出「没人答」。
 * 识别**不按前缀**(用户自己打出「[No answer] …」那是用户的答复,照样贴标签),只认 SYSTEM_ANSWERS 里逐字相同的整句。
 */
export const SYSTEM_ANSWER_PREFIX = '[No answer]';
/** requestInquiry 在 run 中止时兑现的字面量(services/inquiries.ts;中文,不能原样回给模型)。只用来识别。 */
const INQUIRY_ABORTED_ANSWER = '(用户中止了运行)';
/** run 中止导致询问没等到答复时回给模型的系统说明(英文,自带 [No answer] 前缀)。 */
export const INQUIRY_RUN_STOPPED_NOTE =
  `${SYSTEM_ANSWER_PREFIX} The run was stopped before the user answered this question. This is a system note, not the user's reply: do not assume an answer.`;
/**
 * 通道完全停止 / 账号断开时 channels/service.ts 兑现给还挂着的询问的兜底答复(与那边的 INQUIRY_CHANNEL_STOPPED_ANSWER 逐字相同)。
 * 这里留一份是因为 tools → channels/service 会撞进 channels 的模块环;两份漂移由 interaction.test.ts 的钉子测试兜住
 * (那边改了措辞这里没跟上 → 通道兜底会被贴成「User answered」,测试红)。
 */
export const INQUIRY_CHANNEL_STOPPED_ANSWER =
  '[No answer] The chat channel was stopped or disconnected before the user answered this question. This is a system note, not the user\'s reply: do not assume an answer; continue without it or wait for the user to reach out again.';
/** 全部系统代答(逐字)。新增一种兜底答复要加进来,否则会被当成用户的答复贴标签。 */
const SYSTEM_ANSWERS: ReadonlySet<string> = new Set([INQUIRY_RUN_STOPPED_NOTE, INQUIRY_CHANNEL_STOPPED_ANSWER]);

/**
 * 把询问的原始答复规整成「给模型的答复」:run 已中止且拿到的是中止字面量 → 英文系统说明;其余原样。
 * 中止判定要求**信号已中止 + 字面量逐字命中**两条同时成立:用户恰好打出同一串字不会被吞成系统说明,
 * 也不会把「批准后紧接着被中止」的真实批准改判成没答。
 */
export function normalizeInquiryAnswer(answer: string, signal?: AbortSignal): string {
  return signal?.aborted && answer === INQUIRY_ABORTED_ANSWER ? INQUIRY_RUN_STOPPED_NOTE : answer;
}

/** 是否系统代答(非用户本人回复):逐字命中已知的系统说明才算,用户打出同样的开头不算。 */
export function isSystemAnswer(answer: string): boolean {
  return SYSTEM_ANSWERS.has(answer);
}

/** ask_user 的工具结果(给模型,英文):用户答复带「User answered:」标签;系统代答原样交回,不冒充用户。 */
export function formatInquiryResult(answer: string): string {
  return isSystemAnswer(answer) ? answer : `User answered: ${answer}`;
}

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
        if (!ctx.runId) return 'Error: no run context; cannot ask the user';
        const options = (Array.isArray(args.options) ? args.options : [])
          .map((o: any) => String(o ?? '').trim())
          .filter(Boolean)
          .slice(0, MAX_OPTIONS);
        const answer = await requestInquiry(
          ctx.runId,
          { question, options, allowFreeText: true },
          ctx.signal,
        );
        return formatInquiryResult(normalizeInquiryAnswer(answer, ctx.signal));
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
        if (!ctx.runId) return 'Error: no run context';
        // 计划全文走专用事件(客户端渲染计划卡;询问事件只带问题不重复带全文)
        void publish(ctx.runId, 'plan', { plan });
        const rawAnswer = await requestInquiry(
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
        // 只换掉「run 中止」那句中文系统字面量;用户的答复逐字交给 parsePlanAnswer(批准判定口径不变)。
        const answer = normalizeInquiryAnswer(rawAnswer, ctx.signal);
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
            return `The user approved the plan, but turning off plan mode failed: ${e?.message || e}. Ask the user to turn off the plan-mode switch manually.`;
          }
          // 把批准的计划存盘(<cwd>/.tangu/plans/plan-<时间>.md;best-effort,失败不阻断退出)
          // 目录名走 WORKSPACE_DIR_NAME 单一常量 —— 别再写字面量,双名漂移就是那么来的。
          let planFile = '';
          try {
            const cwd = ctx.cwd || process.cwd();
            const d = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
            const dir = join(cwd, WORKSPACE_DIR_NAME, 'plans');
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
            'The user approved the plan; plan mode is now off. ' +
            (planFile ? `The plan was saved to ${planFile}. ` : '') +
            (verdict.revised
              ? `\n\n⚠️ The user **edited the plan**. Below is the final version; follow it, not your original draft:\n\n${finalPlan}\n\n`
              : '') +
            'Now use todo_write to break the plan into a task list (to track progress), then briefly wrap up this turn. ' +
            'The tool set for this turn is still read-only; ' +
            (autoStart
              ? 'execution will start automatically after you wrap up (no need to wait for the user).'
              : "execution starts with the user's next message.")
          );
        }
        // 系统代答(通道停止 / run 中止)不是用户的反馈:不贴「用户没批准,按反馈改」,那会让模型对着一句系统说明改计划。
        if (isSystemAnswer(verdict.raw)) {
          return `The plan was not approved: no answer from the user.\n${verdict.raw}`;
        }
        return `The user did not approve the plan. Their reply: ${verdict.raw}\nRevise the plan per the feedback, then call exit_plan_mode again to resubmit it.`;
      },
    },
  ],
};
