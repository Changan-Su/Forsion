/**
 * 启动头：在 render() 之前一次性打印到 stdout（成为滚动区顶部的固定内容）。
 * 不放进 Ink 动态树——否则会被 <Static> 顶到底部动态区，夹在历史与 live 之间。
 */
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

export function printBanner({
  model,
  cwd,
  execMode,
  storage,
  providers,
}: {
  model: string;
  cwd: string;
  execMode: string;
  storage: string;
  providers: string[];
}): void {
  const where = execMode === 'host' ? `cwd=${cwd}` : `存储=${storage}`;
  const prov = providers.length ? ` · 直连=${providers.join(',')}` : '';
  process.stdout.write(
    '\n' +
      cyan(bold('  ✦ Tangu')) +
      dim(`  本地 agent · model=${model || '(未设置·进去 /model 选)'} · ${where} · 执行=${execMode}${prov}`) +
      '\n' +
      dim('  输入开聊 · /help 命令 · @提及文件 · ↑↓历史 · Tab 补全 · Esc 中止 · Ctrl+C 退出') +
      '\n\n',
  );
}
