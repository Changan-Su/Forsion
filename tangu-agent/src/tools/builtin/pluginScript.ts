/**
 * run_plugin_script —— 多账号模式(core/accountScope.ts)下跑插件包里自带的脚本(比如一个技能的 scripts/transcribe.py)。
 * 这种模式没有 run_bash:引擎不替账号起任意命令,只跑插件包目录里审过的脚本,一次一个、有时长上限(services/pluginScripts.ts)。
 * 单人模式不出现(那里有 run_bash)。工具说明写给模型,英文。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { isMultiAccount } from '../../core/accountScope.js';
import { multiAccountLimits } from '../../core/multiAccountLimits.js';
import { PluginScriptError, runPluginScript } from '../../services/pluginScripts.js';

const STOPPED_TEXT: Record<string, (min: number) => string> = {
  timeout: (min) => `stopped: the script ran longer than ${min} minute(s) and was ended`,
  scratch: () => 'stopped: the script wrote more temporary data than allowed and was ended',
  output: () => 'stopped: the script printed more output than allowed and was ended (output below is cut)',
  aborted: () => 'stopped: the turn was stopped',
};

export const pluginScriptProvider: ToolProvider = {
  id: 'builtin:plugin-script',
  tools: () => isMultiAccount() ? [
    {
      name: 'run_plugin_script',
      mode: 'host',
      capabilities: { sideEffect: 'write', parallel: false, defaultTimeoutMs: 0 }, // 自带时长上限(脚本 + 这一轮)
      definition: {
        type: 'function',
        function: {
          name: 'run_plugin_script',
          description:
            "Run a script that ships inside an installed plugin's skill folder, such as a skill's scripts/transcribe.py. "
            + 'This is the only way to run code here: there is no shell, and scripts you wrote yourself cannot run. '
            + 'Give the skill name and the script path inside that skill folder (an absolute path to the skill\'s script also works). '
            + 'Arguments are passed as a list, exactly as given (no shell quoting or expansion). The script starts in the working directory; '
            + 'file paths in arguments must stay inside your account folder. Only one script runs at a time on this engine, so the call may wait '
            + 'for another to finish, and each run is limited to a few minutes. Returns the exit code, stdout and stderr.',
          parameters: {
            type: 'object',
            properties: {
              skill: { type: 'string', description: 'Name of the plugin skill that contains the script, e.g. "bluebird-video"' },
              script: { type: 'string', description: 'Path of the script inside the skill folder, e.g. "scripts/transcribe.py"' },
              args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments, one string each' },
            },
            required: ['script'],
          },
        },
      },
      execute: async (args, ctx) => {
        if (!ctx.cwd) return 'Error: no working directory for this turn.';
        try {
          const r = await runPluginScript({ skill: args.skill, script: args.script, args: args.args, cwd: ctx.cwd, runId: ctx.runId || 'no-run', signal: ctx.signal });
          const lines = [`script: ${r.script}`, `exit code: ${r.exitCode ?? '(none)'}${r.signal ? ` (signal ${r.signal})` : ''}`];
          if (r.stopped) lines.push(STOPPED_TEXT[r.stopped](multiAccountLimits().scriptMinutes));
          if (r.waitedMs >= 1000) lines.push(`waited ${Math.round(r.waitedMs / 1000)} s for another script to finish`);
          if (r.removedLinks.length) lines.push(`removed ${r.removedLinks.length} link(s) the script left in your folder (links are not allowed there)`);
          lines.push('--- stdout ---', r.stdout || '(empty)', '--- stderr ---', r.stderr || '(empty)');
          const text = lines.join('\n');
          return r.exitCode === 0 && !r.stopped ? text : `Error: the script did not finish cleanly.\n${text}`;
        } catch (e) {
          if (e instanceof PluginScriptError) return `Error: ${e.message}`;
          if ((e as Error)?.name === 'AbortError') return 'Error: the turn was stopped before the script started.';
          throw e;
        }
      },
    },
  ] : [],
};
