/** Opt-in live scenario: does the model reach for the Jupyter notebook plugin's tools when a user talks about a notebook?
 *
 *  The plugin (forsion-plugin-notebook, supplied by `--plugin-src`) gives Tangu `notebook_read` / `notebook_edit` /
 *  `notebook_run`. Nothing in the messages names a tool. What is judged:
 *    · the model used those tools, and did not go around them (the .ipynb as a raw file, Python / Jupyter from a shell);
 *    · the file is still a valid nbformat 4 notebook, cells it was not asked to touch are the same, outputs are saved in it;
 *    · editing and running each raised an approval card (they sit in the "run a command" tier), reading raised none.
 *  `--notebook-neg` runs the same two messages with the plugin left out: it has to come out red, and the detail line
 *  records how the model coped without the tools.
 *
 *  The model's code runs in a real Python process on this machine, so the approval guard is narrow: only the three
 *  notebook tools, only on the fixture notebook, and only while every code cell on disk is plain arithmetic / print
 *  (`sourceAllowed`). Everything else that asks is refused and listed. This is a guard, not a sandbox. */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const NOTEBOOK_TOOLS = ['notebook_read', 'notebook_edit', 'notebook_run'];
const PREFIX = '/extensions/notebook/notebook-kernel'; // 捆绑包目录名 / 引擎插件 id
const FILE = 'analysis.ipynb';
const MSG_FIX = `${FILE} 第三格报错了,帮我看看是什么问题,改好之后把整本重新跑一遍,告诉我平均分和最高分各是多少。`;
const MSG_ADD = '在最后加一格,算平均分的平方,跑出来告诉我结果。';
/** 格子的源码能不能放行去跑。这个场景里合理的代码只有算术和 print,所以见到下面这些就拒:引入模块(math / statistics 除外)、
 *  碰文件 / 进程 / 网络 / 反射的名字、行首的 `!` 和 `%`。宁可错拒(那次运行记成没过、原因写在详情里),不放过。 */
const RISKY = /\b(open|exec|eval|compile|input|breakpoint|globals|locals|vars|getattr|setattr|delattr|__\w+__|os|sys|subprocess|shutil|pathlib|Path|socket|requests|urllib|http|pip|conda)\b|^\s*[!%]/m;
export function sourceAllowed(src) {
  const s = String(src ?? '');
  const mods = [...s.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1]);
  if (/\bimport\b/.test(s) && (!mods.length || mods.some((m) => !/^(math|statistics)$/.test(m)))) return false;
  return !RISKY.test(s);
}

/** 别的工具写进文件的数字写法:改完之后要原样还在(`1.0` 不能变成 `1`)。 */
const LITERALS = ['"keep": 1.0', '"weight": 2.50'];

/** 把构建好的插件拷进隔离共享域的 plugins/notebook(必须是拷贝:引擎不认符号链接的捆绑包)。带哪些文件同插件仓的 scripts/install-dev.mjs。 */
export function plantNotebookPlugin({ src, shared }) {
  if (!src || !existsSync(join(src, 'manifest.json')) || !existsSync(join(src, 'tangu-plugins', 'notebook-kernel', 'dist', 'index.js'))) {
    throw new Error('--plugin-src 须指向构建好的 Jupyter 笔记本插件目录(forsion-plugin-notebook;先在那边 npm run build)');
  }
  const dest = join(shared, 'plugins', 'notebook');
  mkdirSync(dest, { recursive: true });
  for (const f of ['manifest.json', 'main.js']) cpSync(join(src, f), join(dest, f));
  cpSync(join(src, 'tangu-plugins'), join(dest, 'tangu-plugins'), { recursive: true, filter: (s) => !/\/(src|types|node_modules|__pycache__)(\/|$)|tsconfig\.json$/.test(s) });
  return dest;
}

/** 四格的小笔记本,Jupyter 自己写出来的样子(缩进 1 格、一行一个元素)。第三格是坏的,带着上次存下的 NameError。
 *  数据故意只有一列分数:起初用的是「单价 + 数量」,有一次模型修变量名时顺手把均价改成了按数量加权(12.43 而不是 14.63)——
 *  两种算法都讲得通,判据里的数就对不上了。这个场景量的是工具用得对不对,不是口径怎么取,所以换成只有一种算法的数据。 */
export function notebookFixture() {
  const nb = {
    cells: [
      { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# 成绩\n', '\n', '先算平均分,再看最高分。'] },
      { cell_type: 'code', execution_count: 1, id: 'data', metadata: { tags: ['data'], weight: '@@WEIGHT@@' }, outputs: [], source: ['scores = [82, 91, 77, 95]'] },
      { cell_type: 'code', execution_count: 2, id: 'avg', metadata: {}, outputs: [{ ename: 'NameError', evalue: "name 'score' is not defined", output_type: 'error', traceback: ['Traceback (most recent call last):\n', 'Cell In[2], line 1\n', "NameError: name 'score' is not defined"] }], source: ['avg = sum(scores) / len(score)\n', 'print("avg", round(avg, 2))'] },
      { cell_type: 'code', execution_count: null, id: 'best', metadata: {}, outputs: [], source: ['best = max(scores)\n', 'best'] },
    ],
    metadata: { forsion_live: { keep: '@@KEEP@@', note: '别的工具写的' }, kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 1).replace('"@@KEEP@@"', '1.0').replace('"@@WEIGHT@@"', '2.50') + '\n';
}

const joined = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const parseNb = (text) => { try { const nb = JSON.parse(text); return isObj(nb) ? nb : null; } catch { return null; } };
/** 一格存下的输出,拼成文字(流、报错、结果值)。 */
export const outputText = (cell) => (cell?.outputs || []).map((o) => (o.output_type === 'stream' ? joined(o.text) : o.output_type === 'error' ? `${o.ename}: ${o.evalue}` : joined(o.data?.['text/plain']))).join('\n');
const hasError = (cell) => (cell?.outputs || []).some((o) => o.output_type === 'error');

/** 绕开笔记本工具的调用:把 .ipynb 当普通文件读写,或者在 shell 里跑 Python / Jupyter。只列目录、找文件不算。 */
export function bypasses(toolArgs) {
  return (toolArgs || []).filter((a) => {
    const s = String(a.arguments || '');
    if (/^(read_file|write_file|edit_file|multi_edit|apply_patch|read_document)$/.test(a.name)) return /\.ipynb/i.test(s);
    if (a.name === 'run_bash') return /\b(python3?|ipython|jupyter|nbconvert|papermill)\b/i.test(s) || /\b(cat|head|tail|sed|awk|jq|less|more)\b[^|;&]*\.ipynb/i.test(s) || />\s*\S*\.ipynb/i.test(s);
    return false;
  }).map((a) => `${a.name}: ${String(a.arguments || '').slice(0, 160)}`);
}

/** 一次改动之后文件该守住的东西。`changed` = 这次该动的格子 id;`appended` = 允许在末尾加格子(至少加了一格)。
 *  输出和序号可以变(模型可能整本重跑),源码、类型、元数据、顺序不行。返回问题清单,空 = 没问题。 */
export function judgeNotebook(beforeText, afterText, { changed = [], appended = false } = {}) {
  const b = parseNb(beforeText); const a = parseNb(afterText);
  if (!a) return { problems: ['文件不再是合法的 JSON'], nb: null, added: [] };
  const problems = [];
  if (a.nbformat !== 4 || !Array.isArray(a.cells) || !a.cells.every(isObj)) return { problems: ['不再是 nbformat 4 的笔记本'], nb: a, added: [] };
  const ids = a.cells.map((c) => c.id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) problems.push('格子的 id 缺了或者重复');
  for (const c of a.cells) if (c.cell_type === 'code' && (!Array.isArray(c.outputs) || !(c.execution_count === null || Number.isInteger(c.execution_count)))) problems.push(`代码格 ${c.id} 的 outputs / execution_count 不对`);
  if (JSON.stringify(a.metadata) !== JSON.stringify(b.metadata) || a.nbformat_minor !== b.nbformat_minor) problems.push('笔记本一级的元数据 / 版本号变了');
  for (const lit of LITERALS) if (beforeText.includes(lit) && !afterText.includes(lit)) problems.push(`数字的写法变了(${lit} 不在了)`);
  const old = b.cells.map((c) => c.id);
  if (JSON.stringify(ids.filter((id) => old.includes(id))) !== JSON.stringify(old)) problems.push('原有的格子少了或者顺序变了');
  const added = a.cells.filter((c) => !old.includes(c.id));
  if (!appended && added.length) problems.push(`多出了 ${added.length} 格`);
  if (appended && !added.length) problems.push('没有加格子');
  if (appended && added.length && ids.slice(-added.length).some((id) => old.includes(id))) problems.push('新格子没加在最后');
  for (const o of b.cells) {
    const n = a.cells.find((c) => c.id === o.id);
    if (!n) continue;
    const same = n.cell_type === o.cell_type && joined(n.source) === joined(o.source) && JSON.stringify(n.metadata) === JSON.stringify(o.metadata);
    if (changed.includes(o.id)) { if (joined(n.source) === joined(o.source)) problems.push(`该改的那格(${o.id})没改`); if (n.cell_type !== o.cell_type) problems.push(`${o.id} 的类型变了`); }
    else if (!same) problems.push(`没让动的格子(${o.id})被改了`);
  }
  return { problems, nb: a, added };
}

/** --selftest 用:上面两个判据的正例和负对照,[名字, 得到, 应为]。 */
export function notebookSelftest() {
  const before = notebookFixture();
  // 经 JSON.parse 再写出来数字的写法会被整理掉,这里补回去 —— 判据要看的是「别人没动它」。
  const edit = (fn, base = before) => { const nb = JSON.parse(base); fn(nb); return JSON.stringify(nb, null, 1).replace('"keep": 1,', '"keep": 1.0,').replace('"weight": 2.5\n', '"weight": 2.50\n') + '\n'; };
  const fixed = edit((nb) => { nb.cells[2].source = ['avg = sum(scores) / len(scores)\n', 'print("avg", round(avg, 2))']; nb.cells[2].outputs = [{ name: 'stdout', output_type: 'stream', text: ['avg 86.25\n'] }]; nb.cells[1].execution_count = 5; });
  const cell = (id) => ({ cell_type: 'code', execution_count: null, id, metadata: {}, outputs: [], source: ['avg ** 2'] });
  const n = (after, opts, base = before) => judgeNotebook(base, after, opts).problems.length;
  const arg = (name, args) => [{ name, arguments: JSON.stringify(args) }];
  return [
    ['judgeNotebook 改好第三格、整本重跑', n(fixed, { changed: ['avg'] }), 0],
    ['judgeNotebook 什么都没改(负对照)', n(before, { changed: ['avg'] }), 1],
    ['judgeNotebook 动了别的格子(负对照)', n(edit((nb) => { nb.cells[2].source = ['x']; nb.cells[3].source = ['best = 0']; }), { changed: ['avg'] }), 1],
    ['judgeNotebook 数字写法被整理掉(负对照)', n(fixed.replace('"keep": 1.0', '"keep": 1'), { changed: ['avg'] }), 1],
    ['judgeNotebook 少了一格(负对照)', n(edit((nb) => { nb.cells[2].source = ['x']; nb.cells.splice(0, 1); }), { changed: ['avg'] }), 1],
    ['judgeNotebook 不是 JSON(负对照)', n('{', {}), 1],
    ['judgeNotebook 末尾加一格', n(edit((nb) => { nb.cells.push(cell('sq')); }, fixed), { appended: true }, fixed), 0],
    ['judgeNotebook 加在中间(负对照)', n(edit((nb) => { nb.cells.splice(1, 0, cell('sq')); }, fixed), { appended: true }, fixed), 1],
    ['judgeNotebook 让加却没加(负对照)', n(fixed, { appended: true }, fixed), 1],
    ['judgeNotebook 没让加却多了一格(负对照)', n(edit((nb) => { nb.cells[2].source = ['x']; nb.cells.push(cell('sq')); }), { changed: ['avg'] }), 1],
    ['judgeNotebook 序号不是数字(负对照)', n(edit((nb) => { nb.cells[1].execution_count = 'bad'; }, fixed), { changed: ['avg'] }), 1],
    ['sourceAllowed 夹具自己的三格代码', JSON.parse(before).cells.filter((c) => c.cell_type === 'code').every((c) => sourceAllowed(joined(c.source))), true],
    ['sourceAllowed 算式和 print', sourceAllowed('sq = avg ** 2\nprint("%.1f" % sq)'), true],
    ['sourceAllowed 用 statistics 求均值', sourceAllowed('import statistics\navg = statistics.mean(scores)'), true],
    ['sourceAllowed 行首的 !(负对照)', sourceAllowed('x = 1\n!pip list'), false],
    ['sourceAllowed 装包(负对照)', sourceAllowed('%pip install numpy'), false],
    ['sourceAllowed 删文件(负对照)', sourceAllowed('from pathlib import Path\nPath("/x").unlink()'), false],
    ['sourceAllowed 绕着引入(负对照)', sourceAllowed('__import__("o" + "s").remove("x")'), false],
    ['sourceAllowed 夹带别的模块(负对照)', sourceAllowed('import math, shutil'), false],
    ['bypasses 笔记本工具不算', bypasses(arg('notebook_read', { path: FILE })).length, 0],
    ['bypasses 列目录不算', bypasses(arg('run_bash', { command: 'ls -la *.ipynb' })).length, 0],
    ['bypasses 把 .ipynb 当文件读', bypasses(arg('read_file', { path: `/w/${FILE}` })).length, 1],
    ['bypasses shell 里跑 Python', bypasses(arg('run_bash', { command: 'python3 -c "print(1)"' })).length, 1],
    ['bypasses cat 文件', bypasses(arg('run_bash', { command: `cat ${FILE} | head` })).length, 1],
  ];
}

export async function notebookLive({ api, run, workspace, OUT, neg, tokensOf, ttft }) {
  // 自己一个空文件夹当工作目录。台架共用的工作区里有别的场景的夹具(marker.txt、marker-doc.csv):10-12 实测模型装载了数据分析技能后
  // 会去 shell 里用 Python 看那份 CSV,和笔记本无关,却会被「shell 里跑 Python」这条判成绕开。文件夹里只有这一本,这条判据才成立。
  const dir = join(workspace, 'grades');
  mkdirSync(dir, { recursive: true });
  const nbPath = join(dir, FILE);
  const before = notebookFixture();
  writeFileSync(nbPath, before);
  const kernel = (path) => api(`${PREFIX}${path}`, { method: 'POST', body: JSON.stringify({ nb: nbPath }) });

  // 先核环境再烧额度:插件没装载 / 路由不通是台架摆放的问题,不是模型的行为。
  const plugin = ((await api('/agent/plugins')).plugins || []).find((p) => p.id === 'notebook-kernel');
  if (neg && plugin) return { ok: false, detail: '负对照无效:引擎里有 notebook-kernel 插件(--notebook-neg 不该摆插件)' };
  if (!neg) {
    if (!plugin?.active) return { ok: false, detail: `摆放问题:引擎没装载 notebook-kernel(/agent/plugins:${plugin ? JSON.stringify(plugin).slice(0, 200) : '没有这一项'}),见 engine.log` };
    const st = await kernel('/status').catch((e) => ({ error: String(e?.message || e) }));
    if (st.state !== 'dead') return { ok: false, detail: `摆放问题:内核路由不通或内核已经在跑(${JSON.stringify(st).slice(0, 200)})` };
  }

  const rejected = [];
  const realNb = realpathSync(nbPath);
  // 守门:只放这三件工具、只放这一本、要跑的代码得在放行范围里。跑之前看的是盘上那份 —— 通用的文件工具改 .ipynb 不用审批,
  // 只看 notebook_edit 的参数会漏掉从那条路写进去的代码。返回拒的原因,空串 = 放行。
  const guard = (name, raw) => {
    if (!NOTEBOOK_TOOLS.includes(name)) return '不是笔记本工具';
    let args; try { args = JSON.parse(raw); } catch { return '参数读不懂'; }
    let target = ''; try { target = realpathSync(resolve(dir, String(args?.path || ''))); } catch { /* 文件不存在 */ }
    if (target !== realNb) return '不是这本笔记本';
    if (name === 'notebook_edit' && args.source != null && !sourceAllowed(args.source)) return '源码不在放行范围';
    if (name === 'notebook_run') {
      const nb = parseNb(readFileSync(nbPath, 'utf8'));
      if (!nb || !Array.isArray(nb.cells) || nb.cells.some((c) => c?.cell_type === 'code' && !sourceAllowed(joined(c.source)))) return '盘上有不在放行范围的代码';
    }
    return '';
  };
  const onApproval = (p) => {
    const raw = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {});
    const why = guard(p.name, raw);
    if (!why) return undefined;
    rejected.push(`${p.name}(${why}): ${raw.slice(0, 160)}`);
    return 'reject';
  };
  const sid = `live-notebook-${Date.now()}`;
  const cfg = { approvalMode: 'auto-edit', cwd: dir }; // 文件修改免批、命令要批:notebook_edit / notebook_run 声明的是命令那一档
  let ev1; let ev2 = null; let mid = before; let after = before; let status = null;
  try {
    ev1 = await run(sid, MSG_FIX, 420_000, cfg, undefined, onApproval);
    mid = readFileSync(nbPath, 'utf8');
    if (!ev1.error) ev2 = await run(sid, MSG_ADD, 420_000, cfg, undefined, onApproval);
    after = readFileSync(nbPath, 'utf8');
    if (!neg) status = await kernel('/status').catch(() => null);
  } finally {
    if (!neg) await kernel('/shutdown').catch(() => {}); // 不关的话 Python 进程要等引擎退出才走
  }

  const used = (ev, name) => !!ev && ev.toolCalls.includes(name);
  const asked = (ev, name) => !!ev && ev.approvalList.some((a) => a.name === name);
  const ranOk = (ev, re) => !!ev && ev.toolResults.some((r) => r.name === 'notebook_run' && !r.isError && re.test(r.full));
  const by1 = bypasses(ev1.toolArgs); const by2 = bypasses(ev2?.toolArgs);
  const j1 = judgeNotebook(before, mid, { changed: ['avg'] });
  const j2 = judgeNotebook(mid, after, { appended: true });
  const c = (id) => j1.nb?.cells?.find((x) => x.id === id);
  // 怎么改的不管(len(scores)、statistics.mean 都行),看跑出来的结果:第三格不再报错、平均分和最高分存进了各自的输出。
  const fixedOut = !hasError(c('avg')) && /86\.25/.test(outputText(c('avg'))) && /\b95\b/.test(outputText(c('best')));
  const added = j2.added.filter((x) => x.cell_type === 'code');
  const SQUARE = /7439\.(06|1)/; // 86.25² = 7439.0625;取到两位(7439.06)、一位(7439.1)都认
  const addedOut = added.some((x) => !hasError(x) && SQUARE.test(outputText(x)));
  const checks = [
    ['① 用了 notebook_edit 和 notebook_run', used(ev1, 'notebook_edit') && used(ev1, 'notebook_run')],
    ['① 运行成功、结果里有 86.25', ranOk(ev1, /86\.25/)],
    ['① 没绕开工具', by1.length === 0],
    ['① 改和跑都弹了审批、读没弹', asked(ev1, 'notebook_edit') && asked(ev1, 'notebook_run') && !asked(ev1, 'notebook_read')],
    ['① 文件:合法、别的格子没动', j1.problems.length === 0],
    ['① 文件:第三格改对了,平均分和最高分存进了输出', fixedOut],
    ['② 用了 notebook_edit 和 notebook_run', used(ev2, 'notebook_edit') && used(ev2, 'notebook_run')],
    ['② 运行成功、结果里有 7439.06', ranOk(ev2, SQUARE)],
    ['② 没绕开工具', !!ev2 && by2.length === 0],
    ['② 改和跑都弹了审批、读没弹', asked(ev2, 'notebook_edit') && asked(ev2, 'notebook_run') && !asked(ev2, 'notebook_read')],
    ['② 文件:合法、原有的格子没动、新格子在最后', !!ev2 && j2.problems.length === 0],
    ['② 文件:新格子的结果存进了输出', addedOut],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const err = ev1.error || ev2?.error || null;
  // 只记不判:答没答出数字(措辞会变)、第二问是不是只跑了新格子(只跑新格子还算得出来 = 变量跨 run 还在)。
  const said1 = /86\.25/.test(ev1.content || '') && /\b95\b/.test(ev1.content || '');
  const said2 = SQUARE.test(ev2?.content || '');
  const runArgs2 = (ev2?.toolArgs || []).filter((a) => a.name === 'notebook_run').map((a) => { try { return String(JSON.parse(a.arguments).cell); } catch { return '?'; } });
  const tools = (ev) => (ev ? [...new Set(ev.toolCalls)].join(',') || '无' : '没跑');

  writeFileSync(join(OUT, 'notebook-evidence.json'), JSON.stringify({
    leg: neg ? 'negative (plugin left out)' : 'plugin', messages: [MSG_FIX, MSG_ADD], plugin: plugin ? { id: plugin.id, active: plugin.active, version: plugin.version } : null,
    kernel: status ? { state: status.state, python: status.python } : null, checks: checks.map(([name, ok]) => ({ name, ok })), fileProblems: { afterFix: j1.problems, afterAdd: j2.problems },
    bypasses: [...by1, ...by2], rejected, said: { fix: said1, add: said2 }, secondRunCells: runArgs2,
    runs: [ev1, ev2].filter(Boolean).map((ev) => ({
      done: ev.done, error: ev.error, approvals: ev.approvalList, content: ev.content,
      toolCalls: ev.toolArgs.map((a) => ({ name: a.name, arguments: a.arguments })),
      toolResults: ev.toolResults.map((r) => ({ name: r.name, isError: r.isError, length: r.fullLength, head: String(r.full || '').slice(0, 2000) })),
    })),
    notebook: { before, afterFix: mid, afterAdd: after },
  }, null, 1));

  return {
    ok: !err && !!ev1.done && !!ev2?.done && failed.length === 0,
    detail: err || [
      neg ? '负对照(没摆插件,须红)' : `内核 ${status?.python?.kind === 'bundled' ? '自带 Python' : status?.python?.path || '?'} ${status?.python?.version || ''}`.trim(),
      failed.length ? `没过 ${failed.length}/${checks.length}:${failed.join(' / ')}` : `${checks.length} 项都过`,
      `① 工具 ${tools(ev1)};② 工具 ${tools(ev2)}`,
      `审批 ${ev1.approvals + (ev2?.approvals || 0)} 张(拒 ${rejected.length})`,
      ...(by1.length + by2.length ? [`绕开 ${by1.length + by2.length} 次,首条 ${[...by1, ...by2][0]}`] : []),
      ...(j1.problems.length + j2.problems.length ? [`文件:${[...j1.problems, ...j2.problems].join(',')}`] : []),
      `答出数字 ①${said1 ? '是' : '否'} ②${said2 ? '是' : '否'}`,
      `② 跑的格子:${runArgs2.join(',') || '无'}`,
    ].join(';'),
    output: `① ${ev1.content || ''}\n② ${ev2?.content || ''}`, ttftMs: ttft(ev1), tokens: (tokensOf(ev1) || 0) + (ev2 ? tokensOf(ev2) || 0 : 0) || null,
    toolCalls: [...ev1.toolCalls, ...(ev2?.toolCalls || [])],
  };
}
