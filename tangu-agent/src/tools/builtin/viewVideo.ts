/**
 * view_video —— 让 agent「看」本机视频文件(与 view_image 同级、同一条 collectImage 回灌通道)。
 *
 * 引擎不做原生 video 输入(三条 provider 路互不兼容,且「未知端点绝不发未知字段」),懒解 =
 * ffmpeg 抽帧:概览模式把 ≤16 帧拼成一张联络表(contact sheet)一次看全片节奏;time 模式
 * 抽单帧全分辨率细看。两步惯用法与 read_document 的 search→pages 同构。
 *
 * - host-only:对象是宿主机文件路径;ffprobe/ffmpeg 不在则工具不可见(与 transcribe_audio
 *   的桥文件门禁同款「不存在,而非调了报错」;查找不缓存阴性——会话中途装上 ffmpeg 即生效)。
 * - GUI PATH 假阴性:装成 App 的 Electron 只有 launchd 精简 PATH,homebrew 的 ffmpeg 解析
 *   不到 → 复用 engines/config 的 extraBinDirs() 扫常见 bin 目录,拿**绝对路径** spawn。
 * - 时间戳不烧进画面(homebrew ffmpeg 8.x 无 drawtext/freetype),改在文本输出里印逐格秒数
 *   ——反正模型要的是「格子 ↔ 秒」映射,文本比像素更可靠。
 * - 帧取窗口中点(避开 t=0 黑场/片尾死帧);抽帧用输入侧 -ss(关键帧快跳),时长无关 O(N)。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { extraBinDirs } from '../../engines/config.js';
import { citeRefFor } from '../documentPages.js';
import { resolvePath } from '../hostExec.js';
import { amadeusVaultPath } from './amadeus.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

const run = promisify(execFile);

const MAX_FRAMES = 16;
const GRID_COLS = 4;
const TILE_WIDTH = 320; // 联络表单格宽;16 格 jpeg ≈ 200-600KB,远离 5MB 闸与 httpBrain 大 body 坑
const SINGLE_WIDTH = 1280; // time 模式单帧上限宽:provider 视觉入口自己会把超大图二次缩(~1568 长边),
                           // 全分辨率 4K 只多烧 token 不多长眼力 → 对外口径统一说「细看帧(≤1280px 宽)」,不许说 full-resolution
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 与 view_image 同口径

/** PATH + extraBinDirs 找可执行的绝对路径。⚠️不缓存:阴性缓存会让「中途装好 ffmpeg」到重启才生效。 */
function findBin(name: string): string | null {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraBinDirs()].filter(Boolean);
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 概览取样计划:窗口 [start,end] 内取 ≤16 个**中点**时刻(秒,一位小数)。纯函数,单测覆盖。 */
export function planFrameTimes(duration: number, start?: number, end?: number): number[] {
  const s = Math.max(0, Math.min(start ?? 0, duration));
  const e = Math.max(s, Math.min(end ?? duration, duration));
  const span = e - s;
  if (!(span > 0.2)) return [Math.round(Math.max(0, Math.min(s, duration - 0.1)) * 10) / 10];
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.floor(span)));
  const step = span / n;
  return Array.from({ length: n }, (_, i) => Math.round((s + step * (i + 0.5)) * 10) / 10);
}

/** 95 → "01:35";3661 → "1:01:01"。别名位用,渲染端 #t= 只认秒。 */
export function fmtClock(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** 时刻引用锚点(照抄 transcribe_audio 的 citeHint 口径:只教秒,冒号形态渲染端判非法)。 */
function citeHint(videoPath: string): string {
  let ref = videoPath;
  try {
    ref = citeRefFor(videoPath, amadeusVaultPath() || null, path.sep);
  } catch { /* vault 配置缺失 → 绝对路径,锚点照样可点 */ }
  return `Cite a moment for the user: [[${ref}#t=<seconds>|<mm:ss>]], e.g. [[${ref}#t=95|01:35]]. ` +
    'Seconds only after `t=` (a clock form like "1:35" is rejected); put the readable timestamp after the `|`. ' +
    'Copy BOTH bracket pairs; it renders as a clickable chip that opens the video at that moment.';
}

function relDisplay(ctx: ToolContext, abs: string): string {
  const cwd = ctx.cwd || process.cwd();
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

/** 取消/超时必须原样上抛(Codex 评审 08-29 #2):吞掉 AbortError 会把「用户取消」伪装成
 *  「媒体损坏/解码失败」,registry 的超时·取消通道也发不出去,概览循环还会拖着死信号继续空转。 */
function rethrowIfAborted(e: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || (e as any)?.name === 'AbortError') throw e;
}

async function probeDuration(ffprobe: string, abs: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { signal });
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null; // 某些容器回 "N/A" → 诚实报错,别 NaN 进取样计划
  } catch (e) {
    rethrowIfAborted(e, signal);
    return null;
  }
}

/** 抽单帧到 out(输入侧 -ss 快跳);越过 EOF 时 ffmpeg 正常退出但不产文件,调用方按 existsSync 取舍。 */
async function extractFrame(ffmpeg: string, abs: string, t: number, width: number, out: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await run(ffmpeg, ['-y', '-v', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1',
      '-vf', `scale='min(${width},iw)':-2`, '-q:v', '5', out], { signal });
    return existsSync(out);
  } catch (e) {
    rethrowIfAborted(e, signal);
    return false;
  }
}

export const viewVideoProvider: ToolProvider = {
  id: 'builtin:view-video',
  tools: () => [
    {
      name: 'view_video',
      mode: 'host', // 对象是宿主机文件路径;沙箱形态无此路径面也无 ffmpeg
      isEnabledFor: (profile) => !!profile.capabilities.hostExec && !!findBin('ffprobe') && !!findBin('ffmpeg'),
      capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 180_000 },
      definition: {
        type: 'function',
        function: {
          name: 'view_video',
          description:
            'View a video file on the machine by sampling its frames (decoded locally with ffmpeg). ' +
            'Without `time`: returns ONE contact-sheet image of up to 16 evenly sampled frames so you can see what happens across the whole video; ' +
            'each cell\'s timestamp in seconds is listed in the text output (read cells left-to-right, top-to-bottom). ' +
            'With `time`: returns a single detailed frame (up to 1280px wide) at that second — use it after an overview to inspect a moment closely. ' +
            'Use `start`/`end` (seconds) to re-sample a narrower window more densely. Supports any format the local ffmpeg can decode (mp4/mov/mkv/webm/avi/...). ' +
            'The soundtrack is NOT included — for speech, extract the audio track (e.g. run_bash: ffmpeg -i video -vn out.m4a) and use transcribe_audio if available.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Video file path (relative to cwd or absolute)' },
              time: { type: 'number', description: 'Extract ONE detailed frame (up to 1280px wide) at this second instead of the overview sheet' },
              start: { type: 'number', description: 'Overview window start in seconds (default 0)' },
              end: { type: 'number', description: 'Overview window end in seconds (default: video duration)' },
            },
            required: ['path'],
          },
        },
      },
      execute: async (args, ctx): Promise<string> => {
        const rawPath = String(args.path ?? '');
        if (!rawPath) return 'Error: path is required';
        const abs = resolvePath(ctx, rawPath);
        if (!existsSync(abs)) return `Error: file not found: ${rawPath}`;
        if (!ctx.collectImage) return 'Error: this runtime cannot display images (no image return channel).';
        const ffmpeg = findBin('ffmpeg');
        const ffprobe = findBin('ffprobe');
        if (!ffmpeg || !ffprobe) return 'Error: ffmpeg/ffprobe not found on this machine.';

        const duration = await probeDuration(ffprobe, abs, ctx.signal);
        if (duration == null) {
          return `Error: could not determine media duration of ${rawPath} — is it a valid video file ffmpeg can decode?`;
        }
        const rel = relDisplay(ctx, abs);
        const durLine = `${duration.toFixed(1)}s (${fmtClock(duration)})`;

        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-video-'));
        try {
          // ── time 模式:单帧全分辨率 ──
          if (args.time !== undefined && args.time !== null) {
            const t = Math.max(0, Math.min(Number(args.time), Math.max(0, duration - 0.05)));
            if (!Number.isFinite(t)) return 'Error: time must be a number of seconds';
            const out = path.join(tmp, 'frame.jpg');
            if (!(await extractFrame(ffmpeg, abs, t, SINGLE_WIDTH, out, ctx.signal))) {
              return `Error: ffmpeg could not decode a frame at t=${t}s from ${rawPath}`;
            }
            const buf = await fs.readFile(out);
            if (buf.length > MAX_IMAGE_BYTES) return `Error: extracted frame unexpectedly large (${(buf.length / 1024 / 1024).toFixed(1)}MB)`;
            ctx.collectImage({ url: `data:image/jpeg;base64,${buf.toString('base64')}`, name: `${path.basename(abs)}@${fmtClock(t)}` });
            return `Frame at t=${t}s (${fmtClock(t)}) of ${rel} — duration ${durLine} (frame scaled to at most 1280px wide). ` +
              'The frame has been provided to you as visual content — answer from it directly.\n' + citeHint(abs);
          }

          // ── 概览模式:≤16 帧联络表 ──
          const times = planFrameTimes(duration,
            args.start !== undefined ? Number(args.start) : undefined,
            args.end !== undefined ? Number(args.end) : undefined);
          const got: { t: number; file: string }[] = [];
          for (const t of times) {
            const out = path.join(tmp, `f_${String(got.length).padStart(2, '0')}.jpg`);
            if (await extractFrame(ffmpeg, abs, t, TILE_WIDTH, out, ctx.signal)) got.push({ t, file: out });
          }
          if (!got.length) return `Error: ffmpeg could not decode any frames from ${rawPath}`;

          let sheet: string;
          if (got.length === 1) {
            sheet = got[0].file;
          } else {
            const cols = Math.min(GRID_COLS, got.length);
            const rows = Math.ceil(got.length / cols);
            sheet = path.join(tmp, 'sheet.jpg');
            await run(ffmpeg, ['-y', '-v', 'error', '-framerate', '1', '-start_number', '0',
              '-i', path.join(tmp, 'f_%02d.jpg'), '-frames:v', '1',
              '-vf', `tile=${cols}x${rows}:margin=4:padding=4:color=black`, '-q:v', '4', sheet], { signal: ctx.signal });
            if (!existsSync(sheet)) return 'Error: ffmpeg failed to compose the contact sheet';
          }
          const buf = await fs.readFile(sheet);
          if (buf.length > MAX_IMAGE_BYTES) return `Error: contact sheet unexpectedly large (${(buf.length / 1024 / 1024).toFixed(1)}MB)`;
          ctx.collectImage({ url: `data:image/jpeg;base64,${buf.toString('base64')}`, name: `${path.basename(abs)} overview` });

          const cols = Math.min(GRID_COLS, got.length);
          const rowLines: string[] = [];
          for (let r = 0; r * cols < got.length; r++) {
            const cells = got.slice(r * cols, (r + 1) * cols).map((g) => `${g.t}s`);
            rowLines.push(`Row ${r + 1}: ${cells.join('  |  ')}`);
          }
          return `Video ${rel} — duration ${durLine}. Sampled ${got.length} frames into one contact sheet ` +
            `(${cols} per row, read left-to-right then top-to-bottom). Frame timestamps:\n${rowLines.join('\n')}\n` +
            'The sheet has been provided to you as visual content — read it directly.\n' +
            'To inspect a moment closely, call view_video again with time:<seconds> (single full-resolution frame); ' +
            'use start/end to re-sample a narrower window more densely.\n' + citeHint(abs);
        } finally {
          fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
      },
    },
  ],
};
