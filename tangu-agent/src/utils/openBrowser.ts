import { spawn } from 'node:child_process';

/**
 * 系统默认浏览器打开 URL 的命令。
 * Windows 不能走 `cmd /c start "" <url>`:cmd 把 URL 里的 `&` 当命令分隔符,链接在第一个 `&` 处被截断——
 * OAuth authorize 链接只剩 `?response_type=code`,OpenAI 报 missing_required_parameter。
 * rundll32 + FileProtocolHandler 直接走 ShellExecute,不经 cmd 解析(Go pkg/browser 同款)。
 */
export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** 尽力而为:打不开就让用户手动复制终端里打印的链接。 */
export function openBrowser(url: string): void {
  try {
    const { cmd, args } = browserOpenCommand(url);
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}
