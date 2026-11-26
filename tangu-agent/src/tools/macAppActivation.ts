import { forEachChild, parse, type Command, type SyntaxNode } from 'unbash';

/** Route direct application activation through Computer Use. This only classifies explicit shell commands. */
export function shellActivatesMacApp(command: string): boolean {
  if (!command.includes('osascript') && !command.includes('open')) return false;
  const pending: SyntaxNode[] = [parse(command)];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'Command' && activates(node)) return true;
    // A shell function definition does not run its contents.
    if (node.type !== 'Function') forEachChild(node, child => pending.push(child));
  }
  return false;
}

function activates(command: Command): boolean {
  if (!command.name) return false;
  const argv = [command.name.value, ...command.args.map(arg => arg.type === 'Word' ? arg.value : arg.text)];
  let i = 0;
  while (['env', '/usr/bin/env', 'command'].includes(argv[i]) || /^\w+=/.test(argv[i] ?? '')) i++;
  const executable = argv[i]?.split('/').pop();
  const args = argv.slice(i + 1);
  if (executable === 'open') return opensAppWithoutDocument(args);
  if (executable !== 'osascript') return false;
  const lines: string[] = [];
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '-e' && n + 1 < args.length) lines.push(args[++n]);
  }
  if (!lines.length) for (const r of command.redirects) {
    if (r.type === 'HereDoc') lines.push(r.body.text);
    if (r.type === 'HereString' && r.target) lines.push(r.target.value);
  }
  const code = lines.join('\n').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\(\*[\s\S]*?\*\)|--[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  return /(?:^\s*|\b(?:to|then)\s+)activate\b/im.test(code) || /\bset\s+(?:the\s+)?frontmost\b[^\n]*\bto\s+true\b/i.test(code) || /\.\s*activate\s*\(\s*\)/.test(code);
}

/** Opening a document with a selected handler, or launching in the background, is an ordinary shell operation. */
function opensAppWithoutDocument(args: string[]): boolean {
  let target = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--args') break;
    if (/\.app\/?$/i.test(arg)) { target = true; continue; }
    if (!/^-[a-zA-Z]/.test(arg)) return false;
    for (let j = 1; j < arg.length; j++) {
      const option = arg[j];
      if (option === 'g' || option === 'j') return false;
      if (option === 'a' || option === 'b') {
        target = true;
        if (j === arg.length - 1) i++;
        break;
      }
    }
  }
  return target;
}
