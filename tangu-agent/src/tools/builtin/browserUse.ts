/**
 * browser_task —— 把整包网页任务委派给 browser-use 的自主 agent(自带视觉 + 多步循环),
 * 用用户本机已登录的真实 Chrome 跑完并回传结果。
 *
 * 定位:与同目录 browserTools.ts(细粒度 browser_* 原语,agent-browser 驱动)互补——
 * 那套让主 loop 一步步点/填(占主循环上下文);本工具让 browser-use 自己在子 loop 里跑完
 * 「帮我订张票/查我的邮箱/填这个表」这类多步目标,主循环只收最终结果。
 *
 * 实现取向沿用 browserTools.ts:host-only + features.webSearch 门禁、spawn 外部驱动子进程、
 * 配置走 config.json 的 browserUse 段 + TANGU_BROWSER_USE_* env 覆盖。browser-use 是 Python,
 * 故随包内嵌一段薄驱动脚本(RUNNER_PY),运行时物化到 ~/.tangu/browser-use/runner.py 再执行
 * (tsc-only 构建不拷 .py 资产,内嵌物化最省心、dev/prod/打包一致)。
 *
 * 可观测性:runner 每步经 register_new_step_callback 把 720px JPEG 截图以 STEP 定界行打到
 * stdout,本侧增量按行解析、经 ctx.displayFile 即时扇出到桌面对话区——聊天里直播它在干什么
 * (headless / 微信远程会话也能监工)。审批:browser_task 已并入 run_bash 同档(approvals.ts)。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRawSection } from '../../core/config.js';
import { tanguHome } from '../../core/tanguHome.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

/** 钉死的 browser-use 版本(月更多次,必须固定);可经 browserUse.pin / TANGU_BROWSER_USE_PIN 覆盖。 */
const PINNED_VERSION = '0.13.3';
const DEFAULT_TASK_TIMEOUT_MS = 300_000; // 网页任务可达分钟级
const DEFAULT_MAX_STEPS = 50;
const OUTPUT_CAP = 4 * 1024 * 1024;
const RESULT_MAX_CHARS = 40_000;
/** 子进程 stdout 里最终结果的定界符——browser-use 自身可能往 stdout 打日志,靠它精确取回 JSON。 */
const RESULT_MARKER = '<<<TANGU_BROWSER_USE_RESULT>>>';
/** 每步进度事件的行定界符(整行 = 定界符 + JSON;含 720px JPEG 截图 base64,用于聊天区直播)。 */
const STEP_MARKER = '<<<TANGU_BROWSER_USE_STEP>>>';

interface RunnerResult {
  success: boolean;
  result?: string;
  error?: string;
  raw?: string;
  version?: string;
  note?: string;
  enoent?: boolean;
}

interface StepEvent {
  step: number;
  url?: string;
  goal?: string;
  screenshot?: string; // base64 JPEG(已在 runner 侧缩到 720px)
}

// browserUse 设置:config.json 的 browserUse 段为底,env(TANGU_BROWSER_USE_*)覆盖(运维逃生口 / 桌面注入)。
function cfg(): any { return getRawSection('browserUse') || {}; }

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function enabled(): boolean {
  if (process.env.TANGU_BROWSER_USE_ENABLED !== undefined) return process.env.TANGU_BROWSER_USE_ENABLED !== '0';
  return cfg().enabled !== false; // 默认开(仍受 host + webSearch 门禁,只在桌面可见)
}

interface ModelConfig { provider: string; model?: string; apiKey?: string; baseUrl?: string }

/**
 * 解析 browser-use 的模型配置,优先级:env > browserUse.model > 已配置的 direct provider(复用其
 * baseUrl/key + 首个 modelId,OpenAI 兼容)。全部未配返回 null(execute 时给出清晰引导,而非
 * 隐藏工具——保快照确定性)。
 */
function modelConfig(): ModelConfig | null {
  const c = cfg().model || {};
  const provider = String(process.env.TANGU_BROWSER_USE_PROVIDER || c.provider || 'openai').toLowerCase();
  const model = process.env.TANGU_BROWSER_USE_MODEL || c.model;
  const apiKey = process.env.TANGU_BROWSER_USE_API_KEY || c.apiKey;
  const baseUrl = process.env.TANGU_BROWSER_USE_BASE_URL || c.baseUrl;
  const isGateway = ['browser-use', 'browseruse', 'bu'].includes(provider);
  // 网关(ChatBrowserUse)自读 BROWSER_USE_API_KEY env,可不在此填 model/key;openai/anthropic 需 key+model。
  if (isGateway || (apiKey && model)) return { provider, model, apiKey, baseUrl };
  // 回退:复用 direct provider(providers 段首个含 baseUrl+apiKey+modelIds 的条目;强模型效果更好,可用 browserUse.model 覆盖)。
  const providers = getRawSection('providers');
  const list = Array.isArray(providers) ? providers : [];
  for (const p of list) {
    const m = Array.isArray(p?.modelIds) ? p.modelIds[0] : undefined;
    if (p?.baseUrl && p?.apiKey && m) return { provider: 'openai', model: String(m), apiKey: String(p.apiKey), baseUrl: String(p.baseUrl) };
  }
  return null;
}

function notConfiguredHint(): string {
  return 'browser_task is not configured. Set the "browserUse.model" section in ~/.tangu/config.json, '
    + 'e.g. {"provider":"openai","model":"<strong-tool-capable-model>","apiKey":"sk-..."} '
    + '(or "anthropic" with an Anthropic key, or "browser-use" using the BROWSER_USE_API_KEY gateway), '
    + 'or configure a direct provider in the "providers" section (it is reused automatically). '
    + 'browser-use drives its own agent loop and needs a strong tool-capable model.';
}

function uvInstallHint(): string {
  return 'uv not found (needed to run browser-use). Install uv from https://docs.astral.sh/uv/ , '
    + 'or pre-build a venv (`pip install browser-use==' + (cfg().pin || PINNED_VERSION) + '`) and set '
    + '"browserUse.runner":{"mode":"python","bin":"/path/to/venv/bin/python"} in ~/.tangu/config.json '
    + '(or env TANGU_BROWSER_USE_RUNNER_BIN).';
}

/** 运行器命令:默认经 uv 起一个钉死 browser-use 的临时环境;或指向用户自建 venv 的 python。 */
function runnerCommand(): { cmd: string; preArgs: string[]; missingHint: string } {
  const r = cfg().runner || {};
  const explicitBin = process.env.TANGU_BROWSER_USE_RUNNER_BIN || (r.mode === 'python' ? r.bin : undefined);
  if (explicitBin) return { cmd: String(explicitBin), preArgs: [], missingHint: notConfiguredHint() };
  const pin = process.env.TANGU_BROWSER_USE_PIN || cfg().pin || PINNED_VERSION;
  return {
    cmd: 'uv',
    preArgs: ['run', '--no-project', '--python', '3.12', '--with', `browser-use==${pin}`, 'python'],
    missingHint: uvInstallHint(),
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function clip(s: string): string {
  return s.length > RESULT_MAX_CHARS ? `${s.slice(0, RESULT_MAX_CHARS)}\n...[result truncated]` : s;
}

function extractResult(stdout: string): RunnerResult | null {
  const i = stdout.lastIndexOf(RESULT_MARKER);
  if (i < 0) return null;
  try { return JSON.parse(stdout.slice(i + RESULT_MARKER.length).trim()) as RunnerResult; } catch { return null; }
}

/** 每次调用把内嵌的 runner.py 写到 ~/.tangu/browser-use/runner.py(幂等,随包升级即刷新),返回其路径。 */
async function ensureRunner(): Promise<string> {
  const dir = path.join(tanguHome(), 'browser-use');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'runner.py');
  await fs.writeFile(p, RUNNER_PY, 'utf8');
  return p;
}

/** 杀整个进程组(uv→python→Chrome 一锅端,超时/中止不留僵尸浏览器);非 posix 回退杀直接子进程。 */
function killTree(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

/**
 * spawn runner:job 走 stdin(避免超长 task 撑爆 argv);stdout 增量按行解析——STEP 行即时回调
 * onStep(不入缓冲,防截图流吃满 OUTPUT_CAP),其余行进缓冲,最终从 RESULT_MARKER 后取回 JSON。
 */
function spawnRunner(
  cmd: string,
  argv: string[],
  stdinData: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  missingHint: string,
  signal?: AbortSignal,
  onStep?: (e: StepEvent) => void,
): Promise<RunnerResult> {
  return new Promise((resolve) => {
    let child;
    try {
      // detached → 自成进程组,超时可整组 SIGKILL(Chrome 是 python 的子进程,只杀 uv 会留孤儿浏览器)。
      child = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e: any) {
      resolve({ success: false, error: e?.code === 'ENOENT' ? missingHint : String(e?.message || e), enoent: e?.code === 'ENOENT' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let done = false;
    const finish = (r: RunnerResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ success: false, error: `browser_task timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
      finish({ success: false, error: 'aborted' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const consumeLine = (line: string): void => {
      if (line.startsWith(STEP_MARKER)) {
        try { onStep?.(JSON.parse(line.slice(STEP_MARKER.length)) as StepEvent); } catch { /* 坏事件行忽略 */ }
        return; // STEP 行不入缓冲
      }
      if (stdout.length < OUTPUT_CAP) stdout += line + '\n';
    };
    child.stdout?.on('data', (d) => {
      lineBuf += d.toString();
      let i;
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        consumeLine(lineBuf.slice(0, i));
        lineBuf = lineBuf.slice(i + 1);
      }
    });
    child.stderr?.on('data', (d) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString(); });
    child.on('error', (e: any) => {
      finish({ success: false, error: e?.code === 'ENOENT' ? missingHint : String(e?.message || e), enoent: e?.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (done) return;
      if (lineBuf) consumeLine(lineBuf); // 尾部无换行残行
      const parsed = extractResult(stdout);
      if (parsed) {
        if (parsed.result) parsed.result = clip(parsed.result);
        finish(parsed);
      } else {
        finish({ success: false, error: stderr.trim() || `browser-use runner exited ${code} with no result`, raw: stdout.slice(-4000).trim() || undefined });
      }
    });
    try { child.stdin?.end(stdinData); } catch { /* ignore */ }
  });
}

async function runBrowserTask(ctx: ToolContext, args: Record<string, any>): Promise<RunnerResult> {
  if (!enabled()) return { success: false, error: 'browser_task is disabled (TANGU_BROWSER_USE_ENABLED=0)' };
  const task = String(args.task ?? '').trim();
  if (!task) return { success: false, error: 'task is required' };
  const model = modelConfig();
  if (!model) return { success: false, error: notConfiguredHint() };

  const profileMode = String(process.env.TANGU_BROWSER_USE_PROFILE || cfg().profile || 'system').toLowerCase();
  const maxSteps = Number.isFinite(Number(args.max_steps)) && Number(args.max_steps) > 0
    ? Number(args.max_steps)
    : (Number(cfg().maxSteps) > 0 ? Number(cfg().maxSteps) : DEFAULT_MAX_STEPS);
  const allowedDomains = Array.isArray(args.allowed_domains)
    ? args.allowed_domains.map(String)
    : (Array.isArray(cfg().allowedDomains) ? cfg().allowedDomains.map(String) : undefined);

  const job = {
    task,
    startUrl: args.start_url ? String(args.start_url) : undefined,
    maxSteps,
    allowedDomains,
    profile: profileMode === 'dedicated' ? 'dedicated' : 'system',
    chromeProfileDir: String(cfg().chromeProfileDir || 'Default'),
    userDataDir: path.join(tanguHome(), 'browser-use', 'chrome-profile'),
    headless: envBool('TANGU_BROWSER_USE_HEADLESS', cfg().headless === true),
    steps: ctx.displayFile ? true : false, // 无展示闸(TUI/纯云)时 runner 不必生成截图流
    model: { provider: model.provider, model: model.model, baseUrl: model.baseUrl },
  };

  const runnerPath = await ensureRunner();
  const { cmd, preArgs, missingHint } = runnerCommand();
  const env: NodeJS.ProcessEnv = { ...process.env, ANONYMIZED_TELEMETRY: 'false' };
  if (model.apiKey) env.LLM_API_KEY = model.apiKey;
  const timeoutMs = Number(cfg().timeoutMs) > 0 ? Number(cfg().timeoutMs) : DEFAULT_TASK_TIMEOUT_MS;

  // 每步截图直播:runner 发 STEP 行 → 即时 displayFile(dataUrl 内联,已缩 720px JPEG;
  // loop 侧 MAX_DISPLAY_FILES_PER_RUN 兜底截断)。名字带步号+目标,聊天里可读。
  const onStep = ctx.displayFile
    ? (e: StepEvent): void => {
        if (!e?.screenshot) return;
        const goal = (e.goal || '').slice(0, 60);
        ctx.displayFile!({
          name: `browser step ${e.step}${goal ? ` — ${goal}` : ''}.jpg`,
          mime: 'image/jpeg',
          dataUrl: `data:image/jpeg;base64,${e.screenshot}`,
        });
      }
    : undefined;

  return spawnRunner(cmd, [...preArgs, runnerPath], JSON.stringify(job), env, timeoutMs, missingHint, ctx.signal, onStep);
}

export const browserUseProvider: ToolProvider = {
  id: 'builtin:browser-use',
  tools: () => [
    {
      name: 'browser_task',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      // 与 browser_* 共用 'browser' 并发键:一次只驱动一个 Chrome,不与细粒度浏览器工具交错。
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TASK_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_task',
          description:
            'Delegate a whole multi-step web task to an autonomous browser agent (browser-use) that drives the user\'s real, logged-in local Chrome with vision + reasoning, and returns the final result. '
            + 'Use this for goals that need several page interactions or the user\'s existing logins — e.g. "check my inbox for X", "book the cheapest flight on <site>", "fill and submit this form", "research <topic> across these pages". '
            + 'It runs its own loop end-to-end (no step-by-step driving from you). For a single navigate/click/read, prefer the lighter browser_navigate/browser_click tools instead. '
            + 'It acts as the user on logged-in sites — scope it with allowed_domains when possible.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The full natural-language goal to accomplish in the browser.' },
              start_url: { type: 'string', description: 'Optional URL to open first before pursuing the task.' },
              max_steps: { type: 'number', description: 'Optional cap on the agent\'s browser steps (default 50).' },
              allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Optional domain allowlist to scope where the agent may navigate (e.g. ["*.github.com"]).' },
            },
            required: ['task'],
          },
        },
      },
      execute: async (args, ctx) => toJson(await runBrowserTask(ctx, args)),
    },
  ],
};

/** 随包内嵌的 browser-use 薄驱动。运行时物化到 ~/.tangu/browser-use/runner.py。 */
const RUNNER_PY = `#!/usr/bin/env python3
"""Tangu <-> browser-use bridge.
Reads a JSON job on stdin, runs ONE browser-use Agent against the user's real
Chrome, and prints the final result as JSON after a marker line so the caller can
recover it even if browser-use logs to stdout. When job["steps"] is true, each agent
step also emits a STEP marker line carrying a 720px JPEG screenshot (base64) for
live display in the Tangu chat.
  --selfcheck : verify import + config construction WITHOUT launching Chrome / network.
Secrets: LLM_API_KEY (openai/anthropic) via env; browser-use gateway reads BROWSER_USE_API_KEY.
"""
import sys, os, json, asyncio

MARKER = "${RESULT_MARKER}"
STEP = "${STEP_MARKER}"

def _emit(payload):
    sys.stdout.write("\\n" + MARKER + json.dumps(payload) + "\\n")
    sys.stdout.flush()

def _emit_step(payload):
    sys.stdout.write("\\n" + STEP + json.dumps(payload) + "\\n")
    sys.stdout.flush()

def _shrink(b64png, width=720, quality=60):
    """Downscale a base64 PNG screenshot to a compact base64 JPEG (None on any failure)."""
    try:
        import base64, io
        from PIL import Image  # pillow is a browser-use hard dependency
        img = Image.open(io.BytesIO(base64.b64decode(b64png))).convert("RGB")
        w, h = img.size
        if w > width:
            img = img.resize((width, max(1, round(h * width / w))))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None

def _load_llm(model_cfg):
    provider = str(model_cfg.get("provider") or "openai").lower()
    model = model_cfg.get("model")
    api_key = os.environ.get("LLM_API_KEY") or model_cfg.get("apiKey")
    base_url = model_cfg.get("baseUrl")
    if provider == "anthropic":
        from browser_use import ChatAnthropic
        return ChatAnthropic(model=model, api_key=api_key)
    if provider in ("browser-use", "browseruse", "bu"):
        from browser_use import ChatBrowserUse
        return ChatBrowserUse(model=model) if model else ChatBrowserUse()
    from browser_use import ChatOpenAI
    kwargs = {"model": model, "api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)

def _build_browser(job, mode):
    from browser_use import Browser, BrowserProfile
    headless = bool(job.get("headless", False))
    allowed = job.get("allowedDomains") or None
    if mode == "dedicated":
        return Browser(browser_profile=BrowserProfile(
            user_data_dir=job.get("userDataDir"), headless=headless, allowed_domains=allowed))
    # system: reuse the user's real, logged-in Chrome profile
    return Browser.from_system_chrome(profile_directory=job.get("chromeProfileDir") or "Default")

def _make_step_cb(state):
    def cb(browser_state_summary, model_output, step_number):
        state["steps"] += 1
        try:
            shot = getattr(browser_state_summary, "screenshot", None)
            small = _shrink(shot) if shot else None
            goal = ""
            for attr in ("current_state", None):
                src = getattr(model_output, attr, model_output) if attr else model_output
                g = getattr(src, "next_goal", None)
                if g:
                    goal = str(g)
                    break
            ev = {"step": int(step_number), "url": getattr(browser_state_summary, "url", ""), "goal": goal[:200]}
            if small:
                ev["screenshot"] = small
            _emit_step(ev)
        except Exception:
            pass  # 直播失败绝不影响任务本身
    return cb

async def _attempt(job, mode, state):
    from browser_use import Agent
    llm = _load_llm(job.get("model") or {})
    browser = _build_browser(job, mode)
    task = job["task"]
    start_url = job.get("startUrl")
    if start_url:
        task = "First open " + str(start_url) + ". Then: " + task
    kwargs = {"task": task, "llm": llm, "browser": browser}
    if job.get("steps"):
        kwargs["register_new_step_callback"] = _make_step_cb(state)
    agent = Agent(**kwargs)
    history = await agent.run(max_steps=int(job.get("maxSteps") or ${DEFAULT_MAX_STEPS}))
    return history.final_result()

async def _run(job):
    state = {"steps": 0}
    mode = str(job.get("profile") or "system").lower()
    try:
        return await _attempt(job, mode, state), None
    except Exception as e:
        # system 模式 0 步即挂 = 启动期失败(典型:日常 Chrome 占着 profile,Chrome>=136 拒 CDP)
        # -> 自动降级 dedicated profile 重试一次;跑到一半的失败原样抛出。
        if mode == "system" and state["steps"] == 0:
            note = "system Chrome profile unavailable (" + type(e).__name__ + ": " + str(e)[:200] + "); retried with dedicated profile (no existing logins)"
            return await _attempt(job, "dedicated", state), note
        raise

def _selfcheck():
    import browser_use
    from browser_use import Agent, Browser, BrowserProfile, ChatOpenAI  # noqa: F401
    _load_llm({"provider": "openai", "model": "selfcheck", "apiKey": "selfcheck"})
    BrowserProfile(user_data_dir="/tmp/tangu-bu-selfcheck", headless=True)
    import base64, io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (1440, 900), (200, 60, 60)).save(buf, format="PNG")
    small = _shrink(base64.b64encode(buf.getvalue()).decode())
    assert small, "screenshot shrink failed"
    _emit_step({"step": 0, "goal": "selfcheck", "screenshot": small})
    _emit({"success": True, "selfcheck": "ok", "version": getattr(browser_use, "__version__", "?")})

def main():
    if "--selfcheck" in sys.argv:
        try:
            _selfcheck(); return 0
        except Exception as e:
            _emit({"success": False, "error": "selfcheck failed: " + repr(e)}); return 1
    try:
        job = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"success": False, "error": "bad job json: " + repr(e)}); return 1
    try:
        result, note = asyncio.run(_run(job))
        out = {"success": True, "result": result if isinstance(result, str) else str(result)}
        if note:
            out["note"] = note
        _emit(out); return 0
    except Exception as e:
        _emit({"success": False, "error": type(e).__name__ + ": " + str(e)}); return 1

if __name__ == "__main__":
    sys.exit(main())
`;

export const __browserUseInternals = { modelConfig, enabled, notConfiguredHint, spawnRunner, extractResult, RUNNER_PY, STEP_MARKER, RESULT_MARKER };
