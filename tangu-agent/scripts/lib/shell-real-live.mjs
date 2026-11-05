/**
 * shellreal(11-05,Agent 设备隔离 U1 / U2 / U3):真模型在本机做几件真实的事,判据只看磁盘和可验算的输出,不信模型自述。
 *
 *  ① 最近改过的 3 个文件(按台架设好的 mtime 排,答案里顺序要对、最旧的不许混进来)
 *  ② 批量改名 IMG_<n>.JPG → trip-<n>.jpg(磁盘上逐个核对,内容跟着走,旁边的 cover.png 不许动)
 *  ③ 找出最大的两个文件(嵌套目录,答案里两个名字、大的在前)
 *  ④ 在项目里跑 git 和 npm 脚本:分支名 / 最新提交标题来自真仓库;npm 脚本打印 seed.txt 的 sha256 前 12 位(只有真跑了才知道)
 *  ⑤ 删掉一个临时文件夹:磁盘上没了;用了 delete_path 的话它得在引擎回收站里、记着原处(只记录用了哪个工具,不判 —— 这是模型的选择)
 *  外加:系统提示里有这台电脑的环境说明(This computer / run_bash shell / On PATH)。
 *
 * 平台无关:Windows 上同一条 `--only shellreal` 照跑(那里还要求环境说明写的是 bash,除非 --expect-cmd)。
 * 每件事各开一个会话,cwd = 夹具目录;审批由台架代批(记录次数)。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();

/** 名字在正文里按给定顺序出现(取首次出现的位置)。 */
function inOrder(text, names) {
  const at = names.map((n) => text.indexOf(n));
  return at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]);
}

function fixture(root) {
  const now = Date.now() / 1000;
  const files = join(root, 'files');
  mkdirSync(files, { recursive: true });
  // 名字刻意和修改时间顺序无关(字母序 / 大小都排不出这个顺序)
  const recent = [['quarterly-report.md', 5 * 60], ['notes-1105.txt', 20 * 60], ['budget.xlsx', 60 * 60], ['old-draft.md', 3 * 86400], ['archive.zip', 10 * 86400], ['readme.txt', 30 * 86400]];
  for (const [name, age] of recent) {
    const p = join(files, name);
    writeFileSync(p, `${name}\n`);
    utimesSync(p, now - age, now - age);
  }
  const photos = join(root, 'photos');
  mkdirSync(photos, { recursive: true });
  for (const n of ['0007', '0012', '0031']) writeFileSync(join(photos, `IMG_${n}.JPG`), `photo ${n}\n`);
  writeFileSync(join(photos, 'cover.png'), 'cover\n');
  const big = join(root, 'big');
  for (const [rel, size] of [['a/raw-footage.mov', 3_200_000], ['b/c/dataset.csv', 2_100_000], ['b/thumb.png', 300_000], ['small.txt', 1_000], ['a/notes.md', 10_000]]) {
    mkdirSync(join(big, rel, '..'), { recursive: true });
    writeFileSync(join(big, rel), Buffer.alloc(size, 0x61));
  }
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const seed = `seed-${tag()}-${Date.now()}`;
  writeFileSync(join(project, 'seed.txt'), seed);
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'live-proj', version: '1.0.0', private: true,
    scripts: { hello: "node -e \"console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('seed.txt')).digest('hex').slice(0,12))\"" },
  }, null, 2));
  const branch = `feature/launch-${tag().toLowerCase()}`;
  const subject = `Add launch checklist LC-${tag()}`;
  const g = (...a) => execFileSync('git', ['-C', project, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Live Harness'); g('config', 'user.email', 'live@example.com');
  g('add', '.'); g('commit', '-qm', 'Initial commit');
  g('checkout', '-qb', branch);
  writeFileSync(join(project, 'CHECKLIST.md'), '- [ ] ship\n');
  g('add', '.'); g('commit', '-qm', subject);
  const scratch = join(root, 'scratch');
  mkdirSync(join(scratch, 'cache'), { recursive: true });
  writeFileSync(join(scratch, 'cache', 'tmp.bin'), 'tmp');
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return { files, photos, big, project, scratch, branch, subject, hash };
}

export async function shellRealLive({ run, workspace, OUT, shared, argv = [] }) {
  const root = join(workspace, `shell-real-${Date.now()}`);
  const f = fixture(root);
  const cfg = { cwd: root, debugSystemPrompt: true };
  const sid = (k) => `live-shellreal-${k}-${Date.now()}`;
  const steps = {};
  const toolsOf = (ev) => ev.toolArgs.map((t) => `${t.name}${t.name === 'run_bash' ? `: ${String(t.args).slice(0, 160)}` : ''}`);

  // ① 最近改过的文件
  const r1 = await run(sid('recent'), 'List the 3 most recently modified files in the folder `files`, newest first. Just the file names, one per line.', 240_000, cfg);
  steps.recent = { ok: !r1.error && inOrder(r1.content, ['quarterly-report.md', 'notes-1105.txt', 'budget.xlsx']) && !r1.content.includes('readme.txt'), answer: r1.content, tools: toolsOf(r1), approvals: r1.approvals, error: r1.error };

  // ② 批量改名
  const r2 = await run(sid('rename'), 'In the folder `photos`, rename every file named IMG_<number>.JPG to trip-<number>.jpg (keep the number, lower-case extension). Leave any other file alone. Tell me when done.', 240_000, cfg);
  const names = existsSync(f.photos) ? readdirSync(f.photos).sort() : [];
  const want = ['cover.png', 'trip-0007.jpg', 'trip-0012.jpg', 'trip-0031.jpg'];
  const contentKept = ['0007', '0012', '0031'].every((n) => { try { return readFileSync(join(f.photos, `trip-${n}.jpg`), 'utf8') === `photo ${n}\n`; } catch { return false; } });
  steps.rename = { ok: !r2.error && JSON.stringify(names) === JSON.stringify(want) && contentKept, names, tools: toolsOf(r2), approvals: r2.approvals, answer: r2.content, error: r2.error };

  // ③ 最大的两个文件
  const r3 = await run(sid('big'), 'Which two files under the folder `big` (including all subfolders) are the largest? Give each path and its size, largest first.', 240_000, cfg);
  steps.big = { ok: !r3.error && inOrder(r3.content, ['raw-footage.mov', 'dataset.csv']), answer: r3.content, tools: toolsOf(r3), approvals: r3.approvals, error: r3.error };

  // ④ git + npm
  const r4 = await run(sid('gitnpm'), 'In the project folder `project`: which git branch is checked out, and what is the subject line of the latest commit? Then run its npm script `hello` and tell me exactly what it printed.', 300_000, cfg);
  const ranNpm = r4.toolArgs.some((t) => t.name === 'run_bash' && /\bnpm\b/.test(String(t.args)));
  steps.gitnpm = { ok: !r4.error && r4.content.includes(f.branch) && r4.content.includes(f.subject) && r4.content.includes(f.hash) && ranNpm, expect: { branch: f.branch, subject: f.subject, hash: f.hash }, answer: r4.content, tools: toolsOf(r4), approvals: r4.approvals, error: r4.error };

  // ⑤ 删除临时文件夹
  const r5 = await run(sid('delete'), 'Delete the folder `scratch` — it only holds temporary cache files.', 240_000, cfg);
  const gone = !existsSync(f.scratch);
  const usedDeleteTool = r5.toolArgs.some((t) => t.name === 'delete_path');
  // 引擎回收站(services/trash.ts):<tangu home>/trash/<id>/meta.json 记着原处,items/0 是整个文件夹
  const trashDir = join(shared, 'tangu', 'trash');
  const inTrash = existsSync(trashDir) && readdirSync(trashDir).some((id) => {
    try { const m = JSON.parse(readFileSync(join(trashDir, id, 'meta.json'), 'utf8')); return m.kind === 'file' && m.items?.[0]?.from === f.scratch && existsSync(join(trashDir, id, m.items[0].stored, 'cache', 'tmp.bin')); } catch { return false; }
  });
  steps.delete = { ok: !r5.error && gone && (!usedDeleteTool || inTrash), gone, usedDeleteTool, inTrash, tools: toolsOf(r5), approvals: r5.approvals, answer: r5.content, error: r5.error };

  // 环境说明(任取一个 run 的系统提示:同一进程里逐字节相同)
  const sp = r1.systemPrompt || r2.systemPrompt || '';
  const shellLine = /- run_bash shell: ([^\n]*)/.exec(sp)?.[1] || '';
  const machineLine = /- This computer: ([^\n]*)/.exec(sp)?.[1] || '';
  const wantBash = process.platform === 'win32' && !argv.includes('--expect-cmd');
  const envOk = !!machineLine && !!shellLine && /On PATH:/.test(shellLine) && (!wantBash || /^bash \(Git for Windows\)/.test(shellLine));
  steps.environment = { ok: envOk, machineLine, shellLine, captured: !!sp };

  const fileToolCalls = [r1, r2, r3, r4, r5].flatMap((r) => r.toolArgs.map((t) => t.name)).filter((n) => ['move_path', 'copy_path', 'delete_path', 'open_path'].includes(n));
  writeFileSync(join(OUT, 'shellreal-evidence.json'), JSON.stringify({ platform: process.platform, fixture: root, steps, fileToolCalls }, null, 2));
  const mark = (k) => `${k} ${steps[k].ok ? '✓' : '✗'}`;
  return {
    ok: Object.values(steps).every((s) => s.ok),
    detail: `${['environment', 'recent', 'rename', 'big', 'gitnpm', 'delete'].map(mark).join(' · ')};` +
      ` shell=「${shellLine.slice(0, 60)}」;改名用 ${steps.rename.tools.map((t) => t.split(':')[0]).join(',') || '无'};` +
      ` 删除用 ${steps.delete.usedDeleteTool ? `delete_path(回收站${steps.delete.inTrash ? '有' : '没有'})` : steps.delete.tools.map((t) => t.split(':')[0]).join(',') || '无'};` +
      ` 代批 ${[r1, r2, r3, r4, r5].reduce((a, r) => a + (r.approvals || 0), 0)}`,
    output: ['recent', 'rename', 'big', 'gitnpm', 'delete'].map((k) => `【${k}】${steps[k].answer}`).join('\n\n'),
    toolCalls: [r1, r2, r3, r4, r5].flatMap((r) => r.toolCalls),
  };
}
