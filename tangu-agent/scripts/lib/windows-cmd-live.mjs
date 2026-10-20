import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    const ev = await run(`windowscmd-${index}`, `Execute exactly this command once using run_bash: ${JSON.stringify(test.command)}. Do not change it, combine it with another command, or use another tool. If approval is denied, stop and report that.`,
      120_000, { approvalMode: 'auto-edit', maxIterations: 4 }, undefined, () => 'reject');
    const exact = ev.toolArgs.filter(call => {
      try { return call.name === 'run_bash' && JSON.parse(call.arguments).command === test.command; } catch { return false; }
    });
    const output = ev.toolResults.map(result => JSON.stringify(result)).join('\n');
    const approvedArgs = ev.approvalList.map(request => {
      try { return JSON.parse(request.args).command; } catch { return ''; }
    });
    const ok = !ev.error && ev.done && exact.length === 1 && ev.approvals === test.approvals
      && (test.approvals ? approvedArgs.length === 1 && approvedArgs[0] === test.command : output.includes(test.contains));
    evidence.push({ ...test, ok, exactCalls: exact.length, approvals: ev.approvalList, results: ev.toolResults, error: ev.error, output: ev.content });
    console.log(`${ok ? 'PASS' : 'FAIL'} windowscmd ${test.command} approvals=${ev.approvals}`);
  }
  writeFileSync(join(OUT, 'windowscmd-evidence.json'), JSON.stringify(evidence, null, 2));
  return { ok: evidence.every(test => test.ok), detail: `${evidence.filter(test => test.ok).length}/6; dir/type execute without approval; pipe/comma/environment/git request approval and are rejected`, output: evidence.map(test => `${test.command}\n${test.output}`).join('\n---\n'), toolCalls: evidence.flatMap(test => Array(test.exactCalls).fill('run_bash')) };
}
