/**
 * 用户交互工具(类 Claude Code 的 AskUserQuestion / ExitPlanMode):
 *   - ask_user:run 中途向用户提问(选项 + 自由输入),经 inquiries 登记表等答案
 *   - exit_plan_mode:计划模式专用——提交计划求批准;批准则把会话 agent_config.planMode 关掉
 *     (本轮工具集已冻结仍保持只读,下一轮 run 起生效执行)
 * 仅本地形态(hostExec profile)暴露:云端前端(AI Studio)尚无询问 UI,暴露会让模型挂等。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../core/db.js';
import { requestInquiry } from '../../services/inquiries.js';
import { publish } from '../../services/eventBus.js';
import type { ToolProvider } from '../toolRegistry.js';

const MAX_OPTIONS = 6;

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
            '向用户提一个问题并等待回答(可附候选项,用户也可自由输入)。只在**真正需要用户决策**时用:' +
            '需求有歧义、多个合理方案需取舍、操作影响面大需确认。能从上下文/代码推断的不要问。',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '完整的问题(以问号结尾,给足上下文)' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: `候选项(可空;最多 ${MAX_OPTIONS} 个,每项一句话;推荐项放第一个)`,
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
            '计划模式专用:调研完成、计划成形后,把**完整计划**提交给用户审批。' +
            '批准 → 计划模式关闭(下一条消息开始可执行写操作);要求修改 → 按反馈继续完善计划再次提交。',
          parameters: {
            type: 'object',
            properties: {
              plan: { type: 'string', description: '完整实施计划(markdown:目标/步骤/涉及文件/验证方式)' },
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
            options: ['批准,退出计划模式', '需要修改(在输入框写反馈)', '拒绝,保持计划模式'],
            allowFreeText: true,
          },
          ctx.signal,
        );
        if (answer.startsWith('批准')) {
          // 关掉会话的 planMode(读-改-写 agent_config;本轮 defs 已冻结仍只读,下一轮生效)
          try {
            const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [ctx.sessionId]);
            const raw = rows?.[0]?.agent_config;
            const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
            cfg.planMode = false;
            await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = ?`, [JSON.stringify(cfg), ctx.sessionId]);
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
            await writeFile(planFile, plan.endsWith('\n') ? plan : `${plan}\n`, 'utf8');
          } catch {
            planFile = '';
          }
          void publish(ctx.runId, 'plan_approved', planFile ? { file: planFile } : {});
          return (
            '用户已批准计划,计划模式已关闭。' +
            (planFile ? `计划已存档到 ${planFile}。` : '') +
            '现在请用 todo_write 把计划拆成任务清单(便于跟踪进度),并简要总结收尾;' +
            '本轮工具集仍为只读,用户的下一条消息将开始执行。'
          );
        }
        return `用户未批准:${answer}\n请按反馈完善计划,再次调用 exit_plan_mode 提交。`;
      },
    },
  ],
};
