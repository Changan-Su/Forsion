/**
 * 项目上下文路由 × 真 standalone 引擎的冒烟(`npm run smoke:projectctx`,~10s,隔离 home,不碰 ~/.forsion*):
 * 单测(services/projectContext.test.ts)证的是服务层;这里证路由接线 —— 鉴权、按 sessionId 绑定项目、hostExec 闸、
 * 真 git 仓 / 真目录上的读写、409 冲突、用户侧 settings 落点、负对照(伪造 sessionId → 404,无根会话 → 400)。
 * 用法:node scripts/project-context.smoke.mjs [dist/standalone/main.js](先 npm run build)。
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

const ENGINE = process.argv[2] || new URL('../dist/standalone/main.js', import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), 'tangu-projctx-smoke-'));
const shared = join(OUT, 'forsion'); const home = join(shared, 'tangu'); const workspace = join(OUT, 'workspace'); const proj = join(OUT, 'proj');
for (const d of [home, workspace, proj]) mkdirSync(d, { recursive: true });
// 真 git 仓 + 一个项目技能(旧位置)+ 无指令文件
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', proj, ...a], { env, stdio: 'ignore' });
git('init', '-q', '-b', 'main'); writeFileSync(join(proj, 'README.md'), '# demo\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
writeFileSync(join(proj, 'README.md'), '# demo changed\n');
mkdirSync(join(proj, '.forsion', 'skills', 'legacy-one'), { recursive: true });
writeFileSync(join(proj, '.forsion', 'skills', 'legacy-one', 'SKILL.md'), '---\nname: Legacy one\n---\nold');
const TOKEN = randomUUID();
const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const log = [];
const child = spawn(process.execPath, [ENGINE, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'), '--sandbox', 'off', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN],
  { env: { ...process.env, TANGU_HOME: home, TANGU_DEFAULT_WORKSPACE: workspace }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); };
try {
  let health = null;
  for (let i = 0; i < 90 && !health; i++) { health = await fetch(`${base}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null); if (!health) await sleep(1000); }
  if (!health) { console.error('engine did not become healthy\n' + log.join('').slice(-3000)); process.exit(2); }
  console.log('engine up', JSON.stringify(health));
  const created = await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: 'smoke', project_path: proj, project_name: 'proj', agent_config: { execMode: 'host', cwd: proj } }) });
  const sid = created.body?.id || created.body?.session?.id;
  check('建项目会话', created.status === 200 && !!sid, JSON.stringify(created.body).slice(0, 200));
  const rootless = await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: 'rootless', projectless: true, agent_config: { execMode: 'sandbox' } }) });
  const rid = rootless.body?.id || rootless.body?.session?.id;
  const ctx = await api(`/agent/project-context?sessionId=${sid}`);
  const c = ctx.body;
  check('GET context:cwd = 项目 realpath、git 真仓(main,1 处未暂存改动)、无指令文件、旧位置技能可见', ctx.status === 200 && c.git?.repo === true && c.git.branch === 'main' && c.git.unstaged === 1 && c.doc.exists === false && c.doc.path.endsWith('/.tangu/AGENTS.md') && c.skills.some((s) => s.id === 'local:legacy-one' && s.legacy), JSON.stringify({ status: ctx.status, git: c?.git && { repo: c.git.repo, branch: c.git.branch, unstaged: c.git.unstaged, commits: c.git.commits?.length }, doc: c?.doc?.path, skills: c?.skills?.map((s) => s.id) }));
  const bogus = await api(`/agent/project-context?sessionId=${randomUUID()}`);
  const rl = await api(`/agent/project-context?sessionId=${rid}`);
  check('负对照:伪造 sessionId → 404;无根会话 → 400', bogus.status === 404 && rl.status === 400, `${bogus.status} ${rl.status}`);
  const init = await api('/agent/project-context/init', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
  check('init → 磁盘上出现 .tangu/AGENTS.md + .tangu/skills,context.doc.exists', init.status === 200 && init.body.createdDoc === true && existsSync(join(proj, '.tangu', 'AGENTS.md')) && existsSync(join(proj, '.tangu', 'skills')) && init.body.context.doc.exists === true, JSON.stringify({ status: init.status, createdDoc: init.body?.createdDoc }));
  const mtime = init.body.context.doc.mtimeMs;
  const put1 = await api('/agent/project-context/doc', { method: 'PUT', body: JSON.stringify({ sessionId: sid, content: '# mine\n', expectedMtimeMs: mtime }) });
  check('PUT doc(mtime 对得上)→ 200 且落盘', put1.status === 200 && readFileSync(join(proj, '.tangu', 'AGENTS.md'), 'utf8') === '# mine\n', String(put1.status));
  const put2 = await api('/agent/project-context/doc', { method: 'PUT', body: JSON.stringify({ sessionId: sid, content: '# stale\n', expectedMtimeMs: mtime }) });
  check('PUT doc(过期 mtime)→ 409,文件不变', put2.status === 409 && readFileSync(join(proj, '.tangu', 'AGENTS.md'), 'utf8') === '# mine\n', String(put2.status));
  const st = await api('/agent/project-context/settings', { method: 'PUT', body: JSON.stringify({ sessionId: sid, settings: { defaultAgent: 'xyra', approvalMode: 'full-auto', thinkingLevel: 'bogus' } }) });
  const stGet = await api(`/agent/project-context/settings?sessionId=${sid}`);
  check('PUT settings 白名单收窄 → GET 回同值;落在用户侧 project-settings.json 而不是仓库里', st.status === 200 && JSON.stringify(stGet.body.settings) === JSON.stringify({ defaultAgent: 'xyra', approvalMode: 'full-auto' }) && existsSync(join(home, 'project-settings.json')) && !existsSync(join(proj, '.tangu', 'settings.json')), JSON.stringify(stGet.body));
  const byCwd = await api(`/agent/project-context/settings?cwd=${encodeURIComponent(proj)}`);
  const byBadCwd = await api(`/agent/project-context/settings?cwd=${encodeURIComponent(join(OUT, 'nope'))}`);
  check('GET settings?cwd=(没有会话可借的项目)→ 同一份记录;不存在的目录 → 400', byCwd.status === 200 && JSON.stringify(byCwd.body.settings) === JSON.stringify(stGet.body.settings) && byBadCwd.status === 400, `${byCwd.status} ${byBadCwd.status}`);
  const sk = await api('/agent/project-context/skills', { method: 'POST', body: JSON.stringify({ sessionId: sid, slug: 'ship', name: 'Ship it', description: 'release: steps', content: 'Do the steps.' }) });
  const ctx2 = await api(`/agent/project-context?sessionId=${sid}`);
  check('POST skills → .tangu/skills/ship/SKILL.md 落盘,context 再拉能看见两条技能', sk.status === 200 && existsSync(join(proj, '.tangu', 'skills', 'ship', 'SKILL.md')) && ctx2.body.skills.length === 2, JSON.stringify(ctx2.body.skills?.map((s) => [s.id, s.legacy])));
  const bad = await api('/agent/project-context/skills', { method: 'POST', body: JSON.stringify({ sessionId: sid, slug: '../evil', content: 'x' }) });
  check('坏 slug → 400,不落盘', bad.status === 400 && !existsSync(join(OUT, 'evil')), String(bad.status));
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  try { rmSync(OUT, { recursive: true, force: true }); } catch {}
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) console.log(log.join('').slice(-2000));
process.exit(failed ? 1 : 0);
