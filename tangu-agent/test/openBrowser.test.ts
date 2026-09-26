import { describe, expect, it } from 'vitest';
import { browserOpenCommand } from '../src/utils/openBrowser.js';

// 回归:Windows 曾用 `cmd /c start "" <url>`,cmd 在 `&` 处截断 URL,Codex 登录只剩 response_type=code
// → auth.openai.com 报 missing_required_parameter。URL 必须整条作为单个参数交给不经 cmd 解析的程序。
const authUrl = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile&state=s&code_challenge=c&code_challenge_method=S256';

describe('browserOpenCommand', () => {
  it('Windows 不经 cmd,整条 URL 原样作单个参数', () => {
    const { cmd, args } = browserOpenCommand(authUrl, 'win32');
    expect(cmd).not.toMatch(/^cmd(\.exe)?$/i);
    expect(args).toEqual(['url.dll,FileProtocolHandler', authUrl]);
  });

  it('macOS / Linux 直接交给 open / xdg-open', () => {
    expect(browserOpenCommand(authUrl, 'darwin')).toEqual({ cmd: 'open', args: [authUrl] });
    expect(browserOpenCommand(authUrl, 'linux')).toEqual({ cmd: 'xdg-open', args: [authUrl] });
  });
});
