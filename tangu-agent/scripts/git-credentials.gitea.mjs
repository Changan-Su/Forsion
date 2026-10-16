#!/usr/bin/env node
/**
 * 对真 Gitea 的引擎级验证:凭据接缝(services/gitCredentials)× 真正的 gitPush / gitPull(services/gitActions)。
 * Gitea 起在临时目录里(原版、https、自签证书),命令行建用户和访问令牌,用完即删。**绝不对着 git.forsion.net 跑。**
 *
 * 钉:
 *   ① 没有提供方:推送失败(git_failed)、不卡住(GIT_TERMINAL_PROMPT=0),git 的原文是认证失败的样子(isGitAuthFailure 认得)。
 *   ② 提供方第一次给一枚已作废的令牌 → 远端 401 → 接缝让它作废重取 → 第二枚推上去;仓库不存在,推送即建(私有)。
 *      credentials 正好问两次、invalidate 一次。
 *   ③ 另一个克隆里提交并推上去 → 这边 gitPull 快进拿到(updated / commits = 1)。
 *   ④ 两边各有新提交 → gitPull 报 diverged,本地 HEAD 不动。
 *   ⑤ 令牌一直是坏的:只重试一次(credentials 问两次)就按 git_failed 收场;进程环境里开着 GIT_TRACE_CURL / GIT_CURL_VERBOSE
 *      时,失败原文里一行跟踪都没有(带凭据的子进程摘掉了跟踪开关;开着的话请求头会连同 Authorization 一起进 stderr)。
 *      用户自己的凭据助手里存着这个站的旧凭据时,一次也不去问它(问了的话,git 会带着它重试、失败,再叫助手把它删掉)。
 *   ⑥ 提供方说「这次暂时取不到」(fallback)→ 照没有凭据跑,git 认证失败时报提供方给的 code;说「到此为止」→ 直接按它的 code 报。
 *   ⑦ 发布到 Forsion Git(services/forsionGitPublish × Forsion Git 提供方,云端接缝是假的、站是真的):没有远端的项目 →
 *      入口给出由文件夹名整理出来的仓库名(「我的 Demo 站点 (v2)」→ Demo-v2)→ origin 设好并推上去,站上建出私有仓库、上游设好;
 *      名字撞了站上另一个历史不同的仓库 → 推不上去,刚加的 origin 撤掉。
 *   ⑧ 从 Git 克隆(services/gitClone × Forsion Git 提供方):「我的仓库」清单是站上真的那两个(都私有、克隆地址是这个站的);
 *      挑一个克隆下来 → 文件在、克隆出来的仓库配置里没有凭据;站上没有的仓库 → remote_unreachable,不留半个文件夹;
 *      目标已经在了 → target_exists,原来的东西不动。
 *   ⑨ 连接已有远端(gitActions.gitConnectRemote):本地仓库连到站上已有的同名分支 → origin 设好、上游设好;
 *      连一个站上没有的仓库 → remote_unreachable,刚加的 origin 撤掉。
 *   ⑩ 提交身份(services/gitIdentity):git 没配名字和邮箱 → 由账号推出 `<用户名>@noreply.<站的主机>`,只进这一次提交;
 *      推上去之后 Gitea 把这条提交记在这个用户名下(站的 DOMAIN = 主机名,同线上)。仓库和全局配置里都没写身份。
 *   全程:任何一条错误的 message / detail、任何一次返回的 output 里都没有令牌原文或它的 Basic 编码。
 *
 * 负对照(2026-10-10 实跑,各自改一处再跑,下面对应的那条红):
 *   - gitActions.runAction 里不并凭据的 env(注掉 Object.assign 那句)→ ② 红(推不上去)。
 *   - runRemoteAction 去掉「认证失败 → 重取一次」→ ② 红(第一枚坏令牌就收场)。
 *   - runAction 里不调 stripGitTraceEnv → ⑤ 红(失败原文里是一屏 `<= Recv header: …` 的跟踪)。
 *   - runAction 里不加 `-c credential.<origin>.helper=` → ⑤ 红(助手被依次叫了 get → erase:用户存的那份凭据被删)。
 *   - publishToForsionGit 失败时不撤 origin → ⑦ 红(撞名之后仓库里留着指向别人仓库的 origin)。
 *   2026-10-14 实跑:
 *   - gitClone 不经凭据接缝(给 runWithRemoteCredentials 的地址传空)→ ⑧ 红(私有仓库克隆不下来:could not read Username)。
 *   - gitConnectRemote 连不上时不撤 origin → ⑨ 红。
 *   - gitClone 失败时不删文件夹 → ⑧ 红(目标文件夹是引擎自己先独占地建出来的,git 克隆失败不会替它删)。
 *   ⑩ 的对照写在脚本里:同一个人推上去、邮箱是站上不认识的那条提交,站上不记名。
 *
 * 前置:PATH 上有 gitea(macOS:brew install gitea)与 git ≥ 2.31;先 `npm run build`(本脚本引 dist/)。
 * 用法:node scripts/git-credentials.gitea.mjs      (KEEP=1 保留临时目录并打印 Gitea 日志尾部)
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const work = mkdtempSync(join(tmpdir(), 'tangu-git-gitea-'));
const ini = join(work, 'custom/conf/app.ini');
const cert = join(work, 'cert.pem');
const port = await freePort();
const gitea = `https://127.0.0.1:${port}`;
let web;

// 引擎的 git 动作读的都是进程环境:全局 / 系统 git 配置指到空的(不碰本机的钥匙串助手、身份),引擎的家目录放进临时目录
writeFileSync(join(work, 'gitconfig'), '');
Object.assign(process.env, {
  TANGU_HOME: join(work, 'tangu-home'), GIT_CONFIG_GLOBAL: join(work, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_SSL_CAINFO: cert,
  GIT_AUTHOR_NAME: 'Dave', GIT_AUTHOR_EMAIL: 'dave@example.com', GIT_COMMITTER_NAME: 'Dave', GIT_COMMITTER_EMAIL: 'dave@example.com',
});
for (const key of Object.keys(process.env)) if (/^GIT_(TRACE|CURL_VERBOSE|CONFIG_(COUNT|KEY_|VALUE_))/.test(key)) delete process.env[key];
mkdirSync(process.env.TANGU_HOME, { recursive: true });

const { GitActionError, gitCommit, gitConnectRemote, gitPull, gitPush } = await import('../dist/services/gitActions.js');
const { GitCredentialError, isGitAuthFailure, registerGitCredentialProvider, resetGitCredentialProvidersForTest } = await import('../dist/services/gitCredentials.js');
const { installForsionGit } = await import('../dist/services/forsionGit.js');
const { forsionPublishInfo, publishToForsionGit } = await import('../dist/services/forsionGitPublish.js');
const { gitClone, listForsionGitRepos } = await import('../dist/services/gitClone.js');
const { forsionIdentity, resolveGitIdentity } = await import('../dist/services/gitIdentity.js');

const cli = async (...args) => (await run('gitea', [...args, '--work-path', work, '--config', ini], { timeout: 60_000 })).stdout;
const git = async (cwd, ...args) => (await run('git', args, { cwd, timeout: 30_000 })).stdout.trim();
const basic = (username, password) => Buffer.from(`${username}:${password}`).toString('base64');
/** 脚本自己直接用 git 时带凭据的写法(与引擎注入的同一手)。 */
const withCred = (password) => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${gitea}/.extraheader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic('dave', password)}` });
const api = (path, token) => new Promise((resolve, reject) => {
  https.get(`${gitea}${path}`, { ca: readFileSync(cert), headers: token ? { Authorization: `token ${token}` } : {} }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});
/** 给引擎里用 fetch 的地方(列仓库)用:自签证书要自己带 CA。 */
const caFetch = (url, init = {}) => new Promise((resolve, reject) => {
  https.get(url, { ca: readFileSync(cert), headers: init.headers }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: async () => JSON.parse(body) }));
  }).on('error', reject);
});
/** 动作的结局:成功 → { ok, value };GitActionError → { code, detail };别的异常原样抛。 */
const outcome = async (p) => { try { return { ok: true, value: await p }; } catch (e) { if (e instanceof GitActionError) return { ok: false, code: e.code, detail: e.detail || '', message: e.message }; throw e; } };

const shown = []; // 引擎交出来的所有文字(错误原文 / 推送输出),最后统一查有没有带出令牌
const note = (o) => { shown.push(JSON.stringify(o)); return o; };

try {
  await run('gitea', ['cert', '--host', '127.0.0.1', '--ca'], { cwd: work, timeout: 60_000 });
  mkdirSync(join(work, 'custom/conf'), { recursive: true });
  writeFileSync(ini, `
APP_NAME = Forsion Git (engine e2e)
RUN_MODE = prod
WORK_PATH = ${work}

[git]
PATH = ${process.env.GITEA_SERVER_GIT || 'git'}

[server]
PROTOCOL = https
CERT_FILE = ${cert}
KEY_FILE = ${join(work, 'key.pem')}
DOMAIN = 127.0.0.1
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${port}
ROOT_URL = ${gitea}/
DISABLE_SSH = true
OFFLINE_MODE = true

[database]
DB_TYPE = sqlite3
PATH = ${join(work, 'gitea.db')}

[security]
INSTALL_LOCK = true

[service]
DISABLE_REGISTRATION = true

[repository]
DEFAULT_PRIVATE = private
FORCE_PRIVATE = true
; 推到一个还不存在的仓库 = 建出来(私有),与线上 Forsion Git 同一项配置
ENABLE_PUSH_CREATE_USER = true
DEFAULT_PUSH_CREATE_PRIVATE = true

[log]
LEVEL = Info
MODE = file
ROOT_PATH = ${join(work, 'log')}
`);
  await cli('migrate');
  await cli('admin', 'user', 'create', '--username', 'dave', '--email', 'dave@example.com', '--random-password', '--must-change-password=false');
  const mint = async (name) => (await cli('admin', 'user', 'generate-access-token', '--username', 'dave', '--token-name', name, '--scopes', 'write:repository,read:user', '--raw')).trim();
  const token = await mint('forsion-device');
  const bogus = `${token.slice(0, -6)}000000`; // 形状对、但站上没有这一枚(= 被同一设备名重发作废掉的旧令牌)
  assert.ok(token.length > 20 && bogus !== token);

  web = spawn('gitea', ['web', '--work-path', work, '--config', ini], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    if ((await api('/api/healthz').catch(() => null))?.status === 200) break;
    assert.ok(i < 150, 'Gitea 30 秒内没起来');
    await new Promise((r) => setTimeout(r, 200));
  }

  const src = join(work, 'project');
  mkdirSync(src);
  writeFileSync(join(src, 'hello.txt'), 'pushed from Forsion\n');
  await git(src, 'init', '-q', '-b', 'main');
  await git(src, 'add', '-A');
  await git(src, 'commit', '-q', '-m', 'first');
  await git(src, 'remote', 'add', 'origin', `${gitea}/dave/hello.git`);

  // ① 没有提供方:失败、不卡住
  resetGitCredentialProvidersForTest();
  const t0 = Date.now();
  const bare = note(await outcome(gitPush(src)));
  assert.equal(bare.code, 'git_failed', `没有凭据不该推得上去:${JSON.stringify(bare)}`);
  assert.ok(Date.now() - t0 < 20_000, `没有凭据的推送应当马上失败,实际 ${Date.now() - t0} ms`);
  assert.ok(isGitAuthFailure(bare.detail), `认证失败的原文应当被 isGitAuthFailure 认出来:${bare.detail}`);
  console.log(`① 没有提供方 → git_failed(${Date.now() - t0} ms)。git 原文:${bare.detail.replace(/\s+/g, ' ')}`);

  // ② 第一枚是坏的 → 401 → 作废重取 → 推上去(推送即建)
  const asked = [];
  const invalidated = [];
  let current = bogus;
  registerGitCredentialProvider('e2e', {
    credentials: async (origin) => { asked.push(origin); return origin === gitea ? { username: 'dave', password: current } : null; },
    invalidate: (_origin, rejected) => { invalidated.push(rejected.password); if (rejected.password === bogus) current = token; },
  });
  const pushed = note(await outcome(gitPush(src)));
  assert.equal(pushed.ok, true, `带凭据应当推得上去:${JSON.stringify(pushed)}`);
  assert.deepEqual({ remote: pushed.value.remote, branch: pushed.value.branch }, { remote: 'origin', branch: 'main' });
  assert.deepEqual({ asked, invalidated: invalidated.map((p) => (p === bogus ? 'bogus' : 'other')) }, { asked: [gitea, gitea], invalidated: ['bogus'] });
  const repo = JSON.parse((await api('/api/v1/repos/dave/hello', token)).body);
  assert.equal(repo.private, true, '推送建出来的仓库应当是私有的');
  console.log('② 坏令牌 → 作废重取一次 → 推上去(仓库由推送建出来,私有)');

  // ③ 别处提交并推送 → 这边拉到
  await run('git', ['clone', '-q', `${gitea}/dave/hello.git`, 'elsewhere'], { cwd: work, env: withCred(token), timeout: 30_000 });
  const elsewhere = join(work, 'elsewhere');
  writeFileSync(join(elsewhere, 'from-elsewhere.txt'), 'second device\n');
  await git(elsewhere, 'add', '-A');
  await git(elsewhere, 'commit', '-q', '-m', 'from elsewhere');
  await run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: elsewhere, env: withCred(token), timeout: 30_000 });
  const pulled = note(await outcome(gitPull(src)));
  assert.equal(pulled.ok, true, `应当拉得下来:${JSON.stringify(pulled)}`);
  assert.deepEqual(pulled.value, { remote: 'origin', branch: 'main', upstream: 'origin/main', updated: true, commits: 1, ahead: 0 });
  assert.equal(readFileSync(join(src, 'from-elsewhere.txt'), 'utf8'), 'second device\n');
  const again = note(await outcome(gitPull(src)));
  assert.deepEqual({ updated: again.value?.updated, commits: again.value?.commits }, { updated: false, commits: 0 });
  console.log('③ 别处推上去的提交,这边快进拿到;再拉一次 = 没有要拉的');

  // ④ 两边各有新提交 → diverged,不动本地
  writeFileSync(join(elsewhere, 'from-elsewhere.txt'), 'second device, again\n');
  await git(elsewhere, 'commit', '-qam', 'elsewhere again');
  await run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: elsewhere, env: withCred(token), timeout: 30_000 });
  writeFileSync(join(src, 'local.txt'), 'local only\n');
  await git(src, 'add', '-A');
  await git(src, 'commit', '-q', '-m', 'local only');
  const headBefore = await git(src, 'rev-parse', 'HEAD');
  const split = note(await outcome(gitPull(src)));
  assert.equal(split.code, 'diverged', JSON.stringify(split));
  assert.equal(await git(src, 'rev-parse', 'HEAD'), headBefore, '分叉时本地 HEAD 不该动');
  assert.equal(await git(src, 'status', '--porcelain'), '', '分叉时工作区不该动');
  console.log(`④ 两边各有新提交 → diverged(${split.detail.replace(/\n/g, ' / ')}),本地没动`);

  // ⑤ 令牌一直是坏的:只重试一次;开着跟踪也不把头带出来
  resetGitCredentialProvidersForTest();
  const askedBad = [];
  registerGitCredentialProvider('e2e', { credentials: async (origin) => { askedBad.push(origin); return { username: 'dave', password: `${bogus}${askedBad.length}` }; } });
  Object.assign(process.env, { GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1', GIT_TRACE: '1' });
  // 用户自己的凭据助手(钥匙串之类)里存着这个站的一份旧凭据:我们那一枚被拒之后,git 不该去问它,更不该叫它把那份删掉
  const helperLog = join(work, 'helper.log');
  const helper = join(work, 'helper.sh');
  const shellPath = (p) => `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
  writeFileSync(helper, `#!/bin/sh\necho "$1" >> ${shellPath(helperLog)}\nif [ "$1" = get ]; then echo username=dave; echo password=old-stored-pat; fi\n`, { mode: 0o755 });
  // 可选的真 GCM 腿只使用这次台架的明文临时存储,绝不读写用户的 Windows 凭据库。
  const gcm = process.env.GITEA_TEST_GCM;
  let readGcm, savedGcm;
  if (gcm) {
    Object.assign(process.env, { GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: join(work, 'gcm-store'), GCM_INTERACTIVE: 'Never', GCM_PROVIDER: 'generic' });
    const input = `protocol=https\nhost=127.0.0.1:${port}\nusername=dave\n`;
    const options = { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 10_000 };
    execFileSync(gcm, ['store'], { ...options, input: `${input}password=old-stored-pat\n\n` });
    readGcm = () => execFileSync(gcm, ['get'], { ...options, input: `${input}\n` });
    savedGcm = readGcm();
    assert.ok(savedGcm.includes('password=old-stored-pat'), '真 GCM 的隔离存储里确有旧凭据');
    writeFileSync(helper, `#!/bin/sh\necho "$1" >> ${shellPath(helperLog)}\nexec ${shellPath(gcm)} "$1"\n`, { mode: 0o755 });
  }
  await git(src, 'config', '--file', join(work, 'gitconfig'), 'credential.helper', `!sh ${shellPath(helper)}`);
  const refused = note(await outcome(gitPush(src)));
  writeFileSync(join(work, 'gitconfig'), '');
  for (const key of ['GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_TRACE']) delete process.env[key];
  const helperCalls = existsSync(helperLog) ? readFileSync(helperLog, 'utf8').trim().split('\n') : [];
  assert.deepEqual(helperCalls, [], `带凭据的推送被拒之后不该去问用户的凭据助手(实际:${helperCalls.join(' → ')})`);
  if (readGcm) { assert.equal(readGcm(), savedGcm, '推送认证失败不得删除真 GCM 已存的旧凭据'); console.log('⑤ Windows 真 GCM:隔离存储中的旧凭据保留,没有 get / erase 调用或交互提示'); }
  assert.equal(refused.code, 'git_failed', JSON.stringify(refused));
  assert.equal(askedBad.length, 2, `坏令牌只该重取一次,实际问了 ${askedBad.length} 次`);
  // 跟踪开着时 git 把每个请求头 / 响应头都打进 stderr(Authorization 那一行在前面,失败原文只取末尾一段,所以这里钉的是
  // 「一行跟踪都没有」= 带凭据的子进程确实摘掉了开关,而不是碰巧被截掉)
  assert.ok(!/(Send|Recv) header|== Info|Authorization/i.test(refused.detail), `带凭据的子进程不该开着跟踪:${refused.detail.slice(-300)}`);
  console.log('⑤ 令牌一直是坏的 → 只重取一次就收场;进程环境里开着 GIT_TRACE_CURL 时带凭据的子进程也没有打跟踪;用户的凭据助手一次也没被问到');

  // ⑥ 提供方带话:暂时取不到(照没有凭据跑,认证失败时报它的 code)/ 到此为止(直接报)
  resetGitCredentialProvidersForTest();
  registerGitCredentialProvider('e2e', async () => { throw new GitCredentialError('e2e_rate_limited', 'asked too often', undefined, true); });
  assert.equal(note(await outcome(gitPush(src))).code, 'e2e_rate_limited');
  resetGitCredentialProvidersForTest();
  registerGitCredentialProvider('e2e', async () => { throw new GitCredentialError('e2e_needs_setup', 'no account yet', gitea); });
  assert.deepEqual((({ code, detail }) => ({ code, detail }))(note(await outcome(gitPull(src)))), { code: 'e2e_needs_setup', detail: gitea });
  console.log('⑥ 提供方的两种带话都按它给的 code 报出来');

  // ⑦ 发布到 Forsion Git:云端接缝是假的(站点信息 + 凭据由本地这台 Gitea 的令牌充当),站和推送是真的
  resetGitCredentialProvidersForTest();
  const forsionBrain = {
    info: async () => ({ configured: true, webUrl: `${gitea}/`, credentials: true }),
    credential: async () => ({ webUrl: gitea, username: 'dave', password: token }),
  };
  installForsionGit(forsionBrain, { device: 'e2e' });
  const fresh = join(work, '我的 Demo 站点 (v2)');
  mkdirSync(fresh);
  writeFileSync(join(fresh, 'index.html'), '<h1>demo</h1>\n');
  await git(fresh, 'init', '-q', '-b', 'main');
  await git(fresh, 'add', '-A');
  await git(fresh, 'commit', '-q', '-m', 'first');
  const offer = await forsionPublishInfo(fresh);
  assert.deepEqual(offer, { webUrl: gitea, name: 'Demo-v2' });
  const published = note(await outcome(publishToForsionGit(fresh, offer.name)));
  assert.ok(published.ok, `发布应当成功:${JSON.stringify(published)}`);
  assert.equal(published.value.url, `${gitea}/dave/Demo-v2`);
  const created = await api('/api/v1/repos/dave/Demo-v2', token);
  assert.equal(created.status, 200);
  assert.equal(JSON.parse(created.body).private, true);
  assert.equal(await git(fresh, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  assert.equal(await git(fresh, 'remote', 'get-url', 'origin'), `${gitea}/dave/Demo-v2.git`); // 地址里没有凭据
  // 名字撞了站上另一个历史不同的仓库(② 建的 hello):推不上去 → 刚加的 origin 撤掉,仓库回到点之前的样子
  const clash = join(work, 'clash');
  mkdirSync(clash);
  writeFileSync(join(clash, 'other.txt'), 'unrelated history\n');
  await git(clash, 'init', '-q', '-b', 'main');
  await git(clash, 'add', '-A');
  await git(clash, 'commit', '-q', '-m', 'unrelated');
  const rejected = note(await outcome(publishToForsionGit(clash, 'hello')));
  assert.equal(rejected.code, 'git_failed', JSON.stringify(rejected));
  assert.equal(await git(clash, 'remote'), '');
  console.log('⑦ 发布到 Forsion Git:文件夹名整理成 Demo-v2 → 推送即建(私有)、上游设好;撞名推不上去 → origin 撤掉');

  // ⑧ 从 Git 克隆:清单和克隆都对着真站;凭据由 Forsion Git 提供方给
  const repos = await listForsionGitRepos({ fetch: caFetch });
  assert.deepEqual(repos.map((r) => r.fullName).sort(), ['dave/Demo-v2', 'dave/hello']);
  assert.ok(repos.every((r) => r.private && r.cloneUrl.startsWith(`${gitea}/`) && r.updatedAt), JSON.stringify(repos));
  mkdirSync(join(work, 'cloned'));
  const shelf = realpathSync(join(work, 'cloned')); // 克隆回的是解过软链的真实路径(macOS 的临时目录是软链)
  const got = note(await outcome(gitClone(repos.find((r) => r.fullName === 'dave/hello').cloneUrl, shelf, 'hello-copy')));
  assert.ok(got.ok, `克隆应当成功:${JSON.stringify(got)}`);
  assert.deepEqual(got.value, { path: join(shelf, 'hello-copy'), name: 'hello-copy' });
  assert.ok(existsSync(join(shelf, 'hello-copy/hello.txt')));
  assert.equal(await git(got.value.path, 'remote', 'get-url', 'origin'), `${gitea}/dave/hello.git`);
  const cloneConfig = readFileSync(join(got.value.path, '.git/config'), 'utf8');
  assert.ok(!/extraheader|authorization|helper/i.test(cloneConfig) && !cloneConfig.includes(token), '克隆出来的仓库配置里不该有凭据');
  const missing = note(await outcome(gitClone(`${gitea}/dave/no-such-repo.git`, shelf, 'nothing')));
  assert.equal(missing.code, 'remote_unreachable', JSON.stringify(missing));
  assert.ok(!existsSync(join(shelf, 'nothing')), '克隆失败不该留下文件夹');
  const taken = note(await outcome(gitClone(`${gitea}/dave/Demo-v2.git`, shelf, 'hello-copy')));
  assert.equal(taken.code, 'target_exists');
  assert.ok(existsSync(join(shelf, 'hello-copy/hello.txt')) && !existsSync(join(shelf, 'hello-copy/index.html')));
  console.log(`⑧ 从 Git 克隆:清单 ${repos.length} 个(都私有)→ 克隆下来、仓库配置里没有凭据;站上没有的仓库 → remote_unreachable、不留文件夹;重名 → target_exists`);

  // ⑨ 连接已有远端:本地 main 连到站上已有 main 的仓库 → 上游设好;连不存在的仓库 → origin 撤掉
  const local = join(work, 'connect');
  mkdirSync(local);
  writeFileSync(join(local, 'a.txt'), 'local\n');
  await git(local, 'init', '-q', '-b', 'main');
  await git(local, 'add', '-A');
  await git(local, 'commit', '-q', '-m', 'local first');
  const nowhere = note(await outcome(gitConnectRemote(local, `${gitea}/dave/no-such-repo.git`)));
  assert.equal(nowhere.code, 'remote_unreachable', JSON.stringify(nowhere));
  assert.equal(await git(local, 'remote'), '');
  const connected = note(await outcome(gitConnectRemote(local, `${gitea}/dave/hello.git`)));
  assert.deepEqual(connected.value, { remote: 'origin', upstream: 'origin/main' }, JSON.stringify(connected));
  assert.equal(await git(local, 'remote', 'get-url', 'origin'), `${gitea}/dave/hello.git`);
  assert.equal(await git(local, 'config', 'branch.main.merge'), 'refs/heads/main');
  assert.equal(note(await outcome(gitConnectRemote(local, `${gitea}/dave/Demo-v2.git`))).code, 'has_remote');
  console.log('⑨ 连接已有远端:连不存在的仓库 → remote_unreachable、origin 撤掉;连站上有 main 的仓库 → origin + 上游设好;已有远端 → has_remote');

  // ⑩ 提交身份:git 没配 → 由账号推出不公开的地址,只进这一次提交;推上去后 Gitea 记到这个人名下
  const mine = got.value.path; // ⑧ 克隆下来的 hello
  const ambient = {};
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) { ambient[key] = process.env[key]; delete process.env[key]; }
  writeFileSync(join(mine, 'who.txt'), 'who wrote this\n');
  const who = await resolveGitIdentity(async () => forsionIdentity({ username: 'Dave', nickname: 'Dave D' }, new URL(gitea).hostname), mine);
  assert.deepEqual(who.identity, { name: 'Dave D', email: 'dave@noreply.127.0.0.1', source: 'forsion' });
  const committed = note(await outcome(gitCommit(mine, 'signed by the account', undefined, undefined, who.env)));
  assert.ok(committed.ok, `提交应当成功:${JSON.stringify(committed)}`);
  assert.equal(await git(mine, 'log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'Dave D <dave@noreply.127.0.0.1> / Dave D <dave@noreply.127.0.0.1>');
  assert.equal((await run('git', ['config', '--get-regexp', '^user\\.'], { cwd: mine }).catch((e) => e)).code, 1, '身份不该写进任何 git 配置');
  Object.assign(process.env, ambient);
  const pushedMine = note(await outcome(gitPush(mine)));
  assert.ok(pushedMine.ok, `推送应当成功:${JSON.stringify(pushedMine)}`);
  const sha = await git(mine, 'rev-parse', 'HEAD');
  const onSite = JSON.parse((await api(`/api/v1/repos/dave/hello/git/commits/${sha}`, token)).body);
  assert.equal(onSite.author?.login, 'dave', `Gitea 应当把这条提交记在 dave 名下:${JSON.stringify(onSite.author)} / ${JSON.stringify(onSite.commit?.author)}`);
  // 对照:同一个仓库、同一个人推上去,但邮箱是站上不认识的 → 不记在任何人名下(上面那条不是「谁推的就记给谁」)
  writeFileSync(join(mine, 'stranger.txt'), 'someone else\n');
  await git(mine, 'add', '-A');
  await run('git', ['commit', '-q', '-m', 'unknown email'], { cwd: mine, env: { ...process.env, GIT_AUTHOR_EMAIL: 'stranger@elsewhere.example', GIT_COMMITTER_EMAIL: 'stranger@elsewhere.example' } });
  assert.ok(note(await outcome(gitPush(mine))).ok);
  const strangerSha = await git(mine, 'rev-parse', 'HEAD');
  assert.equal(JSON.parse((await api(`/api/v1/repos/dave/hello/git/commits/${strangerSha}`, token)).body).author, null);
  installForsionGit(undefined);
  console.log('⑩ 提交身份:git 没配 → Dave D <dave@noreply.127.0.0.1> 只进这一次提交、配置里没写;推上去后 Gitea 记在 dave 名下(站上不认识的邮箱 → 不记名)');

  // 全程:令牌原文 / Basic 编码不出现在引擎交出来的任何文字里
  const everything = shown.join('\n');
  const secrets = [token, bogus, `${bogus}1`, `${bogus}2`].flatMap((p) => [p, basic('dave', p)]);
  for (const secret of secrets) assert.ok(!everything.includes(secret), '引擎交出来的文字里出现了令牌或它的 Basic 编码');
  console.log(`全程 ${shown.length} 份输出里没有令牌原文或它的 Basic 编码`);
  console.log('PASS');
} catch (e) {
  console.error('FAIL', e);
  process.exitCode = 1;
} finally {
  web?.kill('SIGTERM');
  if (process.env.KEEP) {
    console.log(`临时目录保留:${work}`);
    try { console.log(readFileSync(join(work, 'log/gitea.log'), 'utf8').split('\n').slice(-40).join('\n')); } catch { /* 没有日志 */ }
  } else {
    await new Promise((r) => setTimeout(r, 300));
    rmSync(work, { recursive: true, force: true });
  }
}
