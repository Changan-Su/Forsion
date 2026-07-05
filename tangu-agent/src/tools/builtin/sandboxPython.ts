/**
 * 云端 Python 沙箱工具:pip_install / run_python(execute 体从 registry.ts 原样搬移)。
 * isEnabledFor:profile.features.sandbox —— 无 docker 的部署(standalone --sandbox none)不再
 * 暴露注定失败的工具(改造前会暴露并在调用时报错;此为有意的小改进,见 Log)。
 */
import { installPackages } from '../../sandbox/dockerProvider.js';
import { runPythonInSession } from '../../sandbox/sessionSandbox.js';
import { formatToolOutput } from '../outputPersist.js';
import type { ToolProvider } from '../toolRegistry.js';

export const sandboxPythonProvider: ToolProvider = {
  id: 'builtin:sandbox-python',
  tools: () => [
    {
      name: 'pip_install',
      mode: 'sandbox',
      isEnabledFor: (profile) => profile.features.sandbox,
      definition: {
        type: 'function',
        function: {
          name: 'pip_install',
          description:
            'Install missing Python packages on demand for the cloud sandbox (binary wheels only). Once installed, run_python can import them; ' +
            'common libraries (python-docx/openpyxl/python-pptx/reportlab/pandas/numpy/matplotlib/Pillow, etc.) are preinstalled and need no installation. ' +
            'Installs are globally cached, so each package only needs to be installed once.',
          parameters: {
            type: 'object',
            properties: {
              packages: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of package names, optionally with versions, e.g. ["openpyxl", "tqdm==4.66.5"]',
              },
            },
            required: ['packages'],
          },
        },
      },
      execute: async (args, ctx) => {
        const raw = args.packages;
        const pkgs = Array.isArray(raw) ? raw.map((p) => String(p)) : raw ? [String(raw)] : [];
        const res = await installPackages(pkgs, { signal: ctx.signal, runId: ctx.runId });
        let out = '';
        if (res.stdout) out += `${res.stdout}\n`;
        if (res.stderr) out += `${res.stderr}\n`;
        out += `exit_code: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}`;
        if (res.exitCode === 0) out = `安装成功，可在 run_python 中 import。\n` + out;
        return out.trim();
      },
    },
    {
      name: 'run_python',
      mode: 'sandbox',
      isEnabledFor: (profile) => profile.features.sandbox,
      definition: {
        type: 'function',
        function: {
          name: 'run_python',
          description:
            'Execute Python 3.12 code in an isolated cloud sandbox (no network) and return stdout/stderr. ' +
            'Before execution the session workspace is synced into /workspace (the current directory); after execution, newly created/modified files are written back to the workspace automatically — you can read and write existing files directly. ' +
            '\n⚠️ Files are only kept if saved in the workspace: save outputs using **relative paths** (i.e. the current directory /workspace, equivalent to /mnt/data). ' +
            'Do not write to /tmp, HOME (~/...) or other absolute paths — those directories are not synced back and files will be lost. ' +
            '\nThe sandbox is pure Python (no node / pandoc / libreoffice), so generate documents directly with the preinstalled libraries: ' +
            'Word→python-docx, Excel→openpyxl/XlsxWriter, PPT→python-pptx, PDF→reportlab/pypdf/pdfplumber, ' +
            'data→pandas/numpy, plotting→matplotlib, images→Pillow. ' +
            'If an import raises ModuleNotFoundError, call pip_install to install the missing package first, then retry.',
          parameters: {
            type: 'object',
            properties: { code: { type: 'string', description: 'The Python code to execute' } },
            required: ['code'],
          },
        },
      },
      execute: async (args, ctx) => {
        const code = String(args.code ?? '');
        // 会话级持久 kernel：import/变量跨调用保留；工作区已 hydrate 在本地，run 末统一 snapshot。
        const res = await runPythonInSession(ctx, code, { signal: ctx.signal, runId: ctx.runId });
        let out = '';
        if (res.stdout) out += `stdout:\n${res.stdout}\n`;
        if (res.stderr) out += `stderr:\n${res.stderr}\n`;
        out += `exit_code: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}${res.aborted ? ' (aborted)' : ''}`;
        out = out.trim() || '(no output)';
        // 超大输出（dump 大表/长日志）落盘到工作区，上下文只回预览+路径；exit_code 在末行→预览尾部必含。
        return formatToolOutput(ctx, 'run_python', out);
      },
    },
  ],
};
