/** Opt-in live acceptance for scoped document instructions; fixtures stay in the harness workspace. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function pageInstructionsLive({ run, workspace, base, token, model }) {
  const label = `PAGE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const inlineLabel = `INLINE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const guidedPath = join(workspace, 'guided-page.md');
  const otherPath = join(workspace, 'other-page.md');
  writeFileSync(guidedPath, ['# Guided page', '', '```forsion-instructions', `When drafting or rewriting content for this page, put the document label ${label} on its own first line.`, '```', '', 'The meeting are scheduled for Thursday.'].join('\n'));
  writeFileSync(otherPath, '# Other page\nThe release are ready.\n');
  const session = `live-page-instructions-${Date.now()}`;
  const guided = await run(session, `Use read_file to read ${guidedPath}, with offset 6 and limit 1. Rewrite that sentence with correct grammar for the page. Show me the draft without changing any files.`, 180_000);
  const other = await run(session, `Now work on ${otherPath}. Use read_file with offset 1 and limit 1 and rewrite that sentence with correct grammar for this other page. Show me the draft without changing any files.`, 180_000);
  const inline = async (body) => {
    const started = Date.now();
    const response = await fetch(`${base}/agent/inline`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: model, ...body }), signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok || !response.body) return { error: `HTTP ${response.status}`, content: '', ms: Date.now() - started };
    const text = await response.text();
    const events = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
    const done = events.find((event) => event.type === 'done');
    return { error: events.find((event) => event.type === 'error')?.error || (done ? null : 'SSE missing done'), content: String(done?.content || ''), toolCallText: !!done?.toolCallText, ms: Date.now() - started };
  };
  const instructions = `When writing content for this page, put the document label ${inlineLabel} on its own first line.`;
  const input = { action: 'custom', instruction: 'Write one short sentence saying the release is ready.', pagePath: guidedPath, pageInstructions: instructions };
  const a = await inline(input);
  const b = await inline({ action: 'custom', instruction: 'Write one short sentence saying the release is ready.', pagePath: otherPath });
  const override = await inline({ ...input, instruction: 'For this edit, omit the document label and output exactly: Release ready.' });
  const requestedRead = guided.toolArgs.find((call) => {
    if (call.name !== 'read_file') return false;
    try { const args = JSON.parse(call.arguments); return args.path === guidedPath && args.offset === 6 && args.limit === 1; } catch { return false; }
  });
  const readResult = guided.toolResults.find((result) => result.name === 'read_file' && !result.isError);
  const checks = {
    paginatedRead: !!requestedRead && !!readResult?.full.includes('Page maintenance instructions') && !/4\tWhen drafting/.test(readResult.full),
    pageConstraint: !guided.error && guided.content.includes(label) && /Thursday/i.test(guided.content),
    otherPageIsolation: !other.error && other.toolCalls.includes('read_file') && !other.content.includes(label) && /release/i.test(other.content),
    inlineConstraint: !a.error && a.content.includes(inlineLabel) && !a.toolCallText,
    inlineIsolation: !b.error && !b.content.includes(inlineLabel) && /release/i.test(b.content),
    currentUserWins: !override.error && override.content.trim() === 'Release ready.',
  };
  return {
    ok: Object.values(checks).every(Boolean), checks,
    detail: Object.entries(checks).map(([key, passed]) => `${key}=${passed}`).join('; ') + ([guided, other, a, b, override].find((result) => result.error)?.error ? `;error=${[guided, other, a, b, override].find((result) => result.error).error}` : ''),
    output: `[guided read]\n${readResult?.full || '(missing)'}\n\n[guided draft]\n${guided.content}\n\n[other page]\n${other.content}\n\n[inline guided]\n${a.content}\n\n[inline other]\n${b.content}\n\n[inline override]\n${override.content}`,
    toolCalls: [...guided.toolCalls, ...other.toolCalls], ttftMs: guided.ttftMs,
  };
}
