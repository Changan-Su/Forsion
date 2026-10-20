import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function windowsCmdVerdict(ev, test) {
  const calls = ev.toolArgs.filter(call => call.name === 'run_bash');
  if (ev.error || !ev.done || ev.toolArgs.length !== 1 || calls.length !== 1 || ev.approvals !== test.approvals) return false;
  try { if (JSON.parse(calls[0].arguments).command !== test.command) return false; } catch { return false; }
  const results = ev.toolResults.filter(result => result.id === calls[0].id && result.name === 'run_bash');
  if (results.length !== 1) return false;
  const result = results[0], text = result.full ?? result.result;
  if (!test.approvals) return !result.isError && text.includes(test.contains) && /exit_code: 0\b/.test(text);
  let requested;
  try { requested = JSON.parse(ev.approvalList[0]?.args).command; } catch { return false; }
  return ev.approvalList.length === 1 && requested === test.command && result.isError
    && text.includes('rejected this tool call, so it was NOT run')
    && ev.approvalResults.length === 1 && ev.approvalResults[0].action === 'reject';
}

/** Real model -> real run_bash -> approval SSE. Deny every approval, so the
 * negative controls can never execute on the developer's computer. */
export async function windowsCmdLive({ run, workspace, OUT }) {
  if (process.platform !== 'win32') throw new Error('windowscmd requires Windows');
  const folder = join(workspace, 'readonly');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'a.txt'), 'WINDOWS_READONLY_SENTINEL\n');
  const cases = [
    { command: `dir /b "${folder}"`, approvals: 0, contains: 'a.txt' },
    { command: `type "${join(folder, 'a.txt')}"`, approvals: 0, contains: 'WINDOWS_READONLY_SENTINEL' },
    ...['dir /b | more', 'type a.txt,b.txt', 'dir %USERPROFILE%', 'git status'].map(command => ({ command, approvals: 1 })),
  ];
  const evidence = [];
  for (const [index, test] of cases.entries()) {
    const ev = await run('windowscmd', `Execute exactly this command once using run_bash: ${JSON.stringify(test.command)}. Do not change it, combine it with another command, or use another tool. If approval is denied, stop and report that.`,
      120_000, { approvalMode: 'auto-edit', maxIterations: 4 }, undefined, () => 'reject');
    const exact = ev.toolArgs.filter(call => {
      try { return call.name === 'run_bash' && JSON.parse(call.arguments).command === test.command; } catch { return false; }
    });
    const ok = windowsCmdVerdict(ev, test);
    evidence.push({ ...test, ok, exactCalls: exact.length, approvals: ev.approvalList, decisions: ev.approvalResults, results: ev.toolResults, error: ev.error, output: ev.content });
    console.log(`${ok ? 'PASS' : 'FAIL'} windowscmd ${test.command} approvals=${ev.approvals}`);
  }
  writeFileSync(join(OUT, 'windowscmd-evidence.json'), JSON.stringify(evidence, null, 2));
  return { ok: evidence.every(test => test.ok), detail: `${evidence.filter(test => test.ok).length}/6; dir/type execute without approval; pipe/comma/environment/git request approval and are rejected`, output: evidence.map(test => `${test.command}\n${test.output}`).join('\n---\n'), toolCalls: evidence.flatMap(test => Array(test.exactCalls).fill('run_bash')) };
}
