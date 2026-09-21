/**
 * desk_present —— Agent Desk:在桌面聊天右侧的演出面板里给用户并排展示文件视图。
 * 经 ctx.presentDesk 闸:loop 即时 publish 'desk_present' 事件,桌面端渲染(面板默认开,用户可关);
 * 纯 UI 事件——不落库、不回灌模型上下文、不触发审批(sideEffect none)。
 * 与 display_file 区别:display_file 是对话流内的一张文件卡片;desk_present 是常驻在聊天
 * 旁边的并排面板,适合「你看着我改」的持续展示。host-only:面板读文件走桌面 readHostFile。
 *
 * desk_screenshot —— 回看:让 agent 真看见面板里渲染出来的样子(HTML 预览/导图/白板/图表),
 * 而不是靠脑补源码。走 deskCapture 往返:引擎发事件 → 桌面端 capturePage → 图经 collectImage
 * 回灌成一条 user 图像消息(与 view_image 同一条通道)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';
import type { DeskPresentSpec } from '../toolTypes.js';
import { requestDeskShot, type DeskShotResult } from '../../services/deskCapture.js';
import { amadeusVaultPath } from './amadeus.js';

const MAX_VIEWS = 2;

/** desk_screenshot 拿到图之后给模型的那句话(纯函数,单测钉住)。伴随面(插件画的形象)单列:09-19 用户实测
 *  agent 截不到 Live3D 形象、只好说「看不到你眼前的画面」;能截之后又得防它把形象当成自己放上去的产物。 */
export function deskShotReply(shot: Pick<DeskShotResult, 'mode' | 'companion'>): string {
  if (shot.companion) {
    return `Screenshot of the Agent Desk is attached. It shows a plugin companion (${shot.companion}): something that plugin draws there, such as an avatar, not content you presented. ` +
      (shot.mode === 'card' ? 'It is the small preview card, the size the user sees it. ' : '') +
      'Look at it and judge what it shows yourself; do not ask the user for a screenshot. ' +
      'If it is still there after you present something, the plugin has replaced the Desk and presented files do not show there.';
  }
  return shot.mode === 'card'
    ? 'Screenshot attached — but the Desk is collapsed to its small preview card, so this is a thumbnail. ' +
      'If you need detail, call desk_present with size:"half" (or "wide") and screenshot again.'
    : 'Screenshot of the Agent Desk is attached as an image. Look at it and judge the result yourself; do not ask the user to describe it.';
}

export const deskPresentProvider: ToolProvider = {
  id: 'builtin:desk-present',
  tools: () => [
    {
      name: 'desk_present',
      mode: 'host',
      isEnabledFor: (profile) => !!profile.capabilities.hostExec,
      capabilities: { sideEffect: 'none', parallel: false },
      definition: {
        type: 'function',
        function: {
          name: 'desk_present',
          // E1 三段式(§五):何时用 → 参数/策略 → 何时别用。ponytail: 上限 600B(实测正好 600)。
          // 「笔记就是 vault 里的 .md,别导出副本」这句留着——它是实测踩过的坑(模型会先 export 再展示),
          // 不是可有可无的措辞;视图 id 的举例砍到一个,其余由 params schema 承担。
          description:
            'Present one or two things in the Agent Desk — a stage panel the user watches beside the chat while you work. ' +
            'Items: {type:"file", path} or {type:"view", view} (a registered desktop view type id such as "calendar", plus optional params). ' +
            'Vault files open in Forsion\'s NATIVE editors; Amadeus notes ARE plain .md there — pass the vault-relative or absolute path, never an exported copy. Other files get a generic preview (HTML live). ' +
            'size: "card" collapses to the preview card; "half"/"wide" expand it. ' +
            'Use it for deliberate presentation, not after every edit; an unavailable panel is not an error.',
          parameters: {
            type: 'object',
            properties: {
              views: {
                type: 'array',
                description: 'Items to show, top to bottom (max 2).',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['file', 'view'], description: '"file" shows a local file; "view" opens a registered desktop view.' },
                    path: { type: 'string', description: 'For "file": path — absolute, relative to cwd, or an Amadeus vault-relative note path.' },
                    view: { type: 'string', description: 'For "view": the registered view type id.' },
                    params: { type: 'object', description: 'For "view": optional params passed to the view.' },
                  },
                  required: ['type'],
                },
              },
              size: { type: 'string', enum: ['card', 'half', 'wide'], description: 'Presentation mode: "card" collapses to the preview card; "half"/"wide" expand the side panel at that width (width ignored once the user resized it).' },
              note: { type: 'string', description: 'One short sentence shown in the panel header: why you are showing this.' },
            },
            required: ['views'],
          },
        },
      },
      execute: async (args, ctx): Promise<string> => {
        if (!ctx.presentDesk) return 'Error: Agent Desk is not available in this environment.';
        const raw = Array.isArray(args.views) ? args.views : [];
        const views: DeskPresentSpec['views'] = [];
        const isFile = async (f: string): Promise<boolean> => {
          try {
            return (await fs.stat(f)).isFile();
          } catch {
            return false;
          }
        };
        for (const v of raw.slice(0, MAX_VIEWS)) {
          if (v?.type === 'view') {
            const id = String(v.view ?? '').trim();
            if (!id) return 'Error: view items need { type: "view", view: "<view type id>" }.';
            const params = v.params && typeof v.params === 'object' && !Array.isArray(v.params) ? (v.params as Record<string, unknown>) : undefined;
            const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : undefined;
            views.push({ type: 'view', view: id, ...(params ? { params } : {}), ...(name ? { name } : {}) });
            continue;
          }
          const p = String(v?.path ?? '').trim();
          if (!p) continue;
          let abs = path.isAbsolute(p) ? p : path.resolve(ctx.cwd || process.cwd(), p);
          if (!(await isFile(abs))) {
            // vault 兜底:Amadeus 笔记以 vault 相对路径流通(amadeus 工具的口径)——agent 不必先拼绝对路径。
            const inVault = path.isAbsolute(p) ? null : path.resolve(amadeusVaultPath(), p);
            if (inVault && (await isFile(inVault))) abs = inVault;
            else return `Error: file not found: ${p}`;
          }
          views.push({ type: 'file', path: abs, name: path.basename(abs) });
        }
        if (!views.length) return 'Error: views must contain at least one { type: "file" | "view" } item.';
        const size = args.size === 'card' || args.size === 'half' || args.size === 'wide' ? args.size : undefined;
        const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 200) : undefined;
        ctx.presentDesk({ views, size, note });
        const names = views.map((v) => (v.type === 'file' ? v.name : v.name || v.view)).join(', ');
        return `Presented in Agent Desk: ${names}. (The user may have the panel hidden; no confirmation is available.) ` +
          'To see how it actually renders, take a look with desk_screenshot.';
      },
    },
    {
      name: 'desk_screenshot',
      mode: 'host',
      isEnabledFor: (profile) => !!profile.capabilities.hostExec,
      deferred: true, // 低频「回看」动作 → 只在目录留一行,用时 load_tools 解锁(省常驻 defs 预算)
      deferHint: 'Screenshot the Agent Desk panel to see how what you presented (or a plugin avatar there) actually renders.',
      // 超时给 20s:桌面端自己 8s 内必答(deskCapture),留出截图/缩放/回传的余量。
      capabilities: { sideEffect: 'read', parallel: false, defaultTimeoutMs: 20_000 },
      definition: {
        type: 'function',
        function: {
          name: 'desk_screenshot',
          description:
            'Take a screenshot of the Agent Desk panel and look at it yourself — the rendered pixels of whatever is currently on the Desk (HTML preview, mindmap, whiteboard, note editor, chart, any view, or a plugin companion such as a 3D avatar). ' +
            'Use it to CHECK YOUR OWN WORK visually: after building a page/diagram/layout, present it with desk_present and then screenshot it to verify it actually looks right, then fix what you see. ' +
            'The image comes back as an image you can see (needs a vision-capable model). ' +
            'Only what is on screen is captured — present something first (not needed to look at what is already there, such as a companion), and prefer size:"half"/"wide" so the capture is big enough to read.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      execute: async (_args, ctx): Promise<string> => {
        if (!ctx.presentDesk || !ctx.runId) return 'Error: Agent Desk is not available in this environment.';
        if (!ctx.collectImage) return 'Error: this environment has no image channel back to the model (cannot show you the screenshot).';
        const shot = await requestDeskShot(ctx.runId, ctx.signal);
        if (!shot.dataUrl) {
          return `Error: could not capture the Agent Desk (${shot.error || 'unknown'}). ` +
            'The panel may be turned off, hidden, or the window too narrow — carry on without the screenshot.';
        }
        ctx.collectImage({ url: shot.dataUrl, name: 'agent-desk.png' });
        return deskShotReply(shot);
      },
    },
  ],
};
