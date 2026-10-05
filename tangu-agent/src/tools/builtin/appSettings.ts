/**
 * app_settings / update_app_settings —— 让 agent 读、改本机 config.json 里的一部分设置(方案 9.3 的 S2a)。
 * 哪些段、哪些字段可见可改,见 services/appSettings.ts(表里没有的对模型不存在)。
 *
 * 安全口径(与 session_settings 同一家,多三条):
 *   - 读工具零副作用、不过闸;写工具是**控制面**(approvals.controlPlaneCall):询问我批准 / 替我批准 档每次都问、
 *     不进「总允许」;完全放行档自动过 —— 但改默认工作目录(workspace 段)任何档位都问(它决定以后每个新会话的免审批写入范围)。
 *   - 远程污点 run 写不了(remoteOrigin.remoteManagementDenied:远端能批自己的卡,弹卡挡不住);通道会话里写工具不可见。
 *   - 子代理 / 讨论 / 团队成员 / Muse / 自动化 一律不可见(同 session_settings:没有「用户这轮说要改」的前提)。
 *   - 只在本机执行形态(mode:'host')露出:config.json 是本机文件,云端会话没有它。
 * 写完发 `app_settings_changed`:桌面端缓存着这份配置(desktopConfig / cfg),不通知它,界面显示的和随 run 带过来的还是旧值。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { publish } from '../../services/eventBus.js';
import { READABLE_SECTIONS, WRITABLE_SECTIONS, renderAppSettings, updateAppSettings } from '../../services/appSettings.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';
import { deps } from '../../seams/runtime.js';

/** 只给「人在这轮对话里」的前台 run(同 sessionSettings.enabledFor)。 */
function enabledFor(_p: unknown, ctx: ToolContext): boolean {
  return !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.inDiscussion && !ctx.muse && !ctx.automationOrigin && !ctx.ephemeral && !ctx.approvalDeferral;
}
/** 这条 run 能不能改(通道来的 / 远程污点的只读)。 */
const canWrite = (ctx: ToolContext): boolean => ctx.runOrigin !== 'channel' && !effectiveRemote(ctx);

export const appSettingsProvider: ToolProvider = {
  id: 'builtin:app_settings',
  tools: () => [
    {
      name: 'app_settings',
      mode: 'host',
      deferred: true,
      deferGroup: 'app_settings',
      deferHint: 'Read the Forsion app settings on this computer and their current values: default / auxiliary models, read-aloud, voice call, voice input, web search, default workspace folder, configured model providers.',
      isEnabledFor: enabledFor,
      definition: {
        type: 'function',
        function: {
          name: 'app_settings',
          description:
            'Read the Forsion app settings stored on this computer (config.json): the default and auxiliary models, read-aloud / voice call / voice input, web search, the default workspace folder, and the configured model providers (ids and model names only). ' +
            'Each option comes with its current value, its allowed values and where it is in Settings. Read-only. ' +
            'Use it to answer what a setting is or which options exist instead of searching the web or the disk. Settings that are not in the result cannot be read or changed by you.',
          parameters: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: [...READABLE_SECTIONS], description: 'Only this section (default: all)' },
            },
          },
        },
      },
      execute: (args, ctx) => renderAppSettings({ section: typeof args?.section === 'string' ? args.section : undefined, writable: canWrite(ctx) }),
    },
    {
      name: 'update_app_settings',
      mode: 'host',
      deferred: true,
      deferGroup: 'app_settings',
      deferHint: 'Change a Forsion app setting on this computer (default / auxiliary models, read-aloud, voice input, web search, default workspace folder); the user confirms each change.',
      isEnabledFor: (p, ctx) => enabledFor(p, ctx) && ctx.runOrigin !== 'channel',
      // 审批走控制面(approvals.controlPlaneCall),不是 capabilities.approval:'command' —— 后者进「总允许」。
      definition: {
        type: 'function',
        function: {
          name: 'update_app_settings',
          description:
            'Change Forsion app settings on this computer. Call app_settings first for the fields and their allowed values. Give one section and only the fields to change; the other fields stay as they are, and nothing is saved if any field is invalid. ' +
            'The user confirms every change on an approval prompt, so say why in `reason`. ' +
            'API keys, sign-in, providers, the voice-call model and voice, MCP, hooks, channels, sandbox, remote access and approval rules cannot be changed with this tool — tell the user to change those in Settings.',
          parameters: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: [...WRITABLE_SECTIONS], description: 'Section to change' },
              values: { type: 'object', description: 'Fields to set, e.g. {"voice": "alloy", "speed": 1.2}' },
              reason: { type: 'string', description: 'One short sentence shown to the user on the approval prompt' },
            },
            required: ['section', 'values', 'reason'],
          },
        },
      },
      execute: async (args, ctx) => {
        // 审批闸已硬拒远程污点 run;这里是同一个判定的兜底(run 中途被远端 steer 染色、或有人绕过闸直调)。
        if (effectiveRemote(ctx)) return `Error: ${remoteManagementDenied('update_app_settings', undefined)}`;
        if (ctx.runOrigin === 'channel') return 'Error: App settings cannot be changed from a chat channel. Tell the user to change it in Settings on the computer.';
        const r = await updateAppSettings(ctx.profile ?? deps().profile, args?.section, args?.values);
        if (r.changed.length && ctx.runId) {
          void publish(ctx.runId, 'app_settings_changed', { section: String(args?.section), fields: r.changed, source: 'agent' });
        }
        return r.text;
      },
    },
  ],
};
