/**
 * forsion_guide —— Forsion 自家产品速查(Forsion Git、蓬洲云、商店、造物 / Connect、账号与积分、Clip、Unit、笔记、Muse)。
 * 只读、不碰外界、不用审批;按需加载(目录一行),chat 预设也放行(CHAT_PRESET_DEFERRED)。正文与按会话形态改说法见 knowledge/forsionProducts.ts。
 * 起因:用户反馈「Tangu 不知道 Forsion Git 是什么」(11-16);先做成技能(#716)到不了轻聊天和沙盒会话,改成工具。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { forsionGuide, GUIDE_TOPICS, type GuideTopic } from '../../knowledge/forsionProducts.js';

export const forsionGuideProvider: ToolProvider = {
  id: 'builtin:forsion_guide',
  tools: () => [
    {
      name: 'forsion_guide',
      deferred: true,
      // 只写「是什么」时模型会凭名字自信地编(11-16 live:桌面 Work 3 次里 2 次没查就编了「网页建仓库 + git remote add」),所以明说答之前先装载
      deferHint: "Forsion's own products (Forsion Git, Penzor Cloud 蓬洲云, Store, Creations, Connect, account, Clip, Unit, Muse) are not in your training data: load this before you answer about any of them.",
      definition: {
        type: 'function',
        function: {
          name: 'forsion_guide',
          description:
            "Look up Forsion's own products: what each one is, the exact UI labels to reach it (Chinese / English), and what you can or cannot do about it from this conversation. " +
            "They are not in your training data: use this whenever the user asks about one of them or mentions a Forsion name you don't recognise, instead of saying you don't know or guessing. Read-only.",
          parameters: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                enum: [...GUIDE_TOPICS],
                description: 'Only this part (default: everything). git = Forsion Git; penzor_cloud = Penzor Cloud (蓬洲云) and sync; store; creations = Creations and Forsion Connect; account = account, membership, quota, points; other = Clip, Unit, Notes, Muse, docs.',
              },
            },
          },
        },
      },
      execute: async (args, ctx) => {
        const t = typeof args?.topic === 'string' && (GUIDE_TOPICS as readonly string[]).includes(args.topic) ? (args.topic as GuideTopic) : undefined;
        // 动态 import:registry 静态 import 了本文件,这里只在执行时才要它
        const { toolAvailable } = await import('../registry.js');
        const has = (name: string): boolean => { try { return toolAvailable(name, ctx); } catch { return false; } };
        return forsionGuide({
          host: ctx.execMode === 'host',
          gitTools: has('git_status'),
          account: has('forsion_account'),
          accountAction: has('forsion_account_action'),
          marketplace: has('search_marketplace'),
        }, t);
      },
    },
  ],
};
