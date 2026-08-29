/**
 * transcribe_audio:把本地音频交给 Forsion Desktop 主进程的语音识别链路转写(08-24 引擎原生路 P1)。
 *
 * 引擎自身没有 ASR;完整链路(本地 SenseVoice / 自带-key provider / Forsion 云)住在桌面主进程
 * (desktop/electron/main.ts 的 runTranscribe)。桥 = 桌面常驻 MCP 端点(electron/mcpServer.ts),
 * 发现文件 ~/.forsion/desktop-bridge.json({url,token},0600,桌面每次启动重写;engine-only token,
 * 与外部 agent 的 forsion-mcp.json 是两份凭据——外部那份仍由设置开关管)。
 *
 * 懒连接:每次调用临时建 MCP 客户端,不进 mcp manager 的「进程启动冻结集」——桥端口随桌面启动
 * 变化,冻结集会时有时无。桌面不在 → 发现文件缺失(工具直接不可见)或连接失败(诚实报错,
 * 调用方按 skill 约定回退「交回宿主/告知用户」)。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { forsionSharedDir } from '../../core/tanguHome.js';
import { contentToText } from '../../mcp/toolBridge.js';
import { citeRefFor } from '../documentPages.js';
import { amadeusVaultPath } from './amadeus.js';
import type { ToolProvider } from '../toolRegistry.js';

const bridgeFile = (): string => path.join(forsionSharedDir(), 'desktop-bridge.json');

/** 时刻引用锚点(2026-08-28,与 read_file/read_document/web_fetch 同款「把可原样复制的具体形态
 *  印在输出里」)。转写是**唯一**会产出时间戳的工具 —— 这里不教,`#t=` 锚点就没人会写。
 *  ⚠️ 只教**秒**:冒号形态里 `1:35` 在渲染端判非法(shared/amadeus/pdfLink.ts 的 npt,抄 Logseq
 *     issue #9920 的血:`10:44` 会被读成 10 小时 44 分),让模型写冒号必然踩空。秒数本来就是
 *     segments[].start 的原值,零换算。可读时间放别名位(`|01:35`),那里怎么写都不影响跳转。
 *  ⚠️ 转写对象常常是从视频里抽出来的**临时音轨**,引它等于给用户一条点不开的路 —— 明说要引原件。 */
function withCiteHint(out: string, audioPath: string): string {
  let ref = audioPath;
  try {
    ref = citeRefFor(audioPath, amadeusVaultPath() || null, path.sep);
  } catch { /* vault 配置缺失 → 用绝对路径,锚点照样可点 */ }
  const hint = `Cite a moment for the user: [[${ref}#t=<start seconds>|<mm:ss>]], e.g. [[${ref}#t=95|01:35]]. ` +
    'Seconds only after `t=` (a clock form like "1:35" is rejected); put the readable timestamp after the `|`. ' +
    'If this file is a temporary audio track extracted from a video, cite the original video path instead. ' +
    'Copy BOTH bracket pairs; it renders as a clickable chip that opens the media at that moment.';
  // ⚠️ 本工具的输出契约是**一份 JSON**(`{text, segments}`),调用方会 JSON.parse ——
  //    像 read_file 那样在尾巴上追加一行会把它变成非法 JSON(transcribeAudio.bridge.test 当场红)。
  //    所以锚点作为一个字段塞进去,不动外层形状。
  try {
    const j = JSON.parse(out);
    if (j && typeof j === 'object' && !Array.isArray(j)) return JSON.stringify({ ...j, cite: hint });
  } catch { /* 后端没吐 JSON → 退回尾部追加,教了总比不教强 */ }
  return `${out}\n\n${hint}`;
}

// ASR 可能真的很慢(长音频/本地模型冷启),给到 9min——仍在 registry 默认 600s 能力位之内。
const CALL_TIMEOUT_MS = 540_000;

function readBridge(): { url: string; token: string } | null {
  try {
    const j = JSON.parse(readFileSync(bridgeFile(), 'utf8'));
    if (typeof j?.url === 'string' && j.url && typeof j?.token === 'string' && j.token) return j;
  } catch { /* 缺失/坏文件 → 视为桥不在 */ }
  return null;
}

export const transcribeAudioProvider: ToolProvider = {
  id: 'builtin:transcribe-audio',
  tools: () => [
    {
      name: 'transcribe_audio',
      mode: 'host', // 转写对象是宿主机文件路径;沙箱形态无此路径面
      // 桥发现文件在才露出:桌面从未安装/纯 TUI 无桌面 → 工具不存在,而非调了等超时。
      // (文件可能陈旧——桌面装过后退出;残余由调用期连接失败兜住,错误信息指明桌面未运行。)
      isEnabledFor: (profile) => !!profile.capabilities.hostExec && existsSync(bridgeFile()),
      definition: {
        type: 'function',
        function: {
          name: 'transcribe_audio',
          description:
            'Transcribe a local audio file via the Forsion Desktop speech-recognition pipeline ' +
            '(local offline model or the ASR provider configured in desktop settings). Returns JSON {text, segments?}. ' +
            'Use this when a transcription script reports the media has no subtitle track and hands back an audio_path ' +
            '(e.g. source:"needs_asr"). Requires the Forsion desktop app to be running. ' +
            'With timestamps:true you can cite a moment back to the user as [[<media path>#t=<seconds>|<mm:ss>]] — see the line printed after the transcript.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path to a local audio file (wav/mp3/m4a/ogg/flac/webm…).' },
              timestamps: { type: 'boolean', description: 'Also return timed segments [{start,end,text}] when the backend can provide them.' },
              language: { type: 'string', description: 'Optional language hint, e.g. "zh" or "en".' },
            },
            required: ['path'],
          },
        },
      },
      execute: async (args, ctx) => {
        const p = String(args.path ?? '').trim();
        if (!p || !path.isAbsolute(p)) return 'Error: path must be an absolute path to a local audio file';
        const bridge = readBridge();
        if (!bridge) return 'Error: Forsion Desktop bridge not found — is the desktop app installed and running?';
        const client = new Client({ name: 'tangu-engine', version: '1.0.0' });
        try {
          const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
            requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
          });
          await client.connect(transport);
          const result = await client.callTool(
            {
              name: 'transcribe_audio',
              arguments: {
                path: p,
                ...(args.timestamps === true ? { timestamps: true } : {}),
                ...(args.language ? { language: String(args.language) } : {}),
              },
            },
            undefined,
            { timeout: CALL_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) },
          );
          const { text, isError } = contentToText(result);
          // 锚点提示只在**真有时间戳**时给:没有 segments 就没有秒数,教了只会诱发编造。
          return isError ? `Error: ${text}` : args.timestamps === true ? withCiteHint(text, p) : text;
        } catch (e: any) {
          // 凭证防漏:错误可能回显 headers,截断(与 mcp/manager 同口径)。连接被拒 = 桌面没在跑。
          const msg = String(e?.message || e).slice(0, 300);
          return `Error: desktop ASR bridge call failed (is the Forsion desktop app running?): ${msg}`;
        } finally {
          await client.close().catch(() => {});
        }
      },
    },
  ],
};
