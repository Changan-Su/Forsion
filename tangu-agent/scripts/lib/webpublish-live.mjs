/** Opt-in live probe (`--only webpublish`): can the model publish a web page through publish_web_page, from a work session
 *  (host files) and from a chat session (files it writes into the session sandbox), with the per-call approval card, and
 *  can it list what was published (forsion_account section web_pages)?
 *
 *  The engine's cloud URL points at the harness's fake Forsion cloud (lib/account-live.mjs), which keeps the published
 *  pages in memory and answers like server microserver/connect (publicUrl on publish, publicBase on list).
 *  Negative controls (run them when touching this): drop 'publish_web_page' from CHAT_PRESET_DEFERRED → leg 2 goes red
 *  (the chat face cannot publish); in webPublish.ts publish(), skip the sandbox branch (always resolvePath) → leg 2 goes red
 *  (the chat sandbox's files are not on the engine's cwd). */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** webpublishreal: start server/scripts/connect-local.mts (real Connect routes + SQL on PGlite) from a server checkout and read
 *  its ready line. Tokens stay in memory; nothing it prints is written to the run's artifacts. */
export function startConnectLocal(serverDir) {
  const dir = resolve(serverDir || '');
  const script = join(dir, 'scripts', 'connect-local.mts');
  const tsx = join(dir, 'node_modules', '.bin', 'tsx');
  if (!serverDir || !existsSync(script) || !existsSync(tsx)) return Promise.reject(new Error(`--connect-server <server 检出>:要有 scripts/connect-local.mts 且装过依赖(${dir})`));
  const proc = spawn(tsx, [script], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok, fail) => {
    let out = '', err = '';
    const timer = setTimeout(() => { proc.kill(); fail(new Error(`connect-local 60 秒没就绪:${err.slice(-400)}`)); }, 60_000);
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').slice(0, -1).find((l) => l.startsWith('CONNECT_LOCAL ')); // 只认收齐的整行
      if (!line) return;
      clearTimeout(timer);
      ok({ ...JSON.parse(line.slice('CONNECT_LOCAL '.length)), stop: () => { try { proc.kill('SIGTERM'); } catch { /* gone */ } } });
    });
    proc.on('exit', (c) => { clearTimeout(timer); fail(new Error(`connect-local 退出 ${c}:${err.slice(-400)}`)); });
  });
}

const CHAT = { preset: 'chat', execMode: 'sandbox', cwd: undefined };
const called = (ev, name) => ev.toolCalls.includes(name) && ev.toolResults.some((r) => r.name === name && !r.isError && !/^Error/.test(r.full || ''));

export async function webPublishLive({ run, cloud, workspace }) {
  const legs = [];
  const leg = (name, ok, why, ev) => { legs.push({ name, ok, why, ev }); return ok; };
  const sid = (k) => `live-webpublish-${k}-${Date.now()}`;
  const posts = () => cloud.posts('/api/connect/apps');

  // 1. Work session: publish a folder that also holds a .env. One card (reason 'always'), nothing sent before the answer,
  //    then one POST with exactly the two page files, and the reply gives the link.
  {
    const site = join(workspace, 'book-club');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>周末读书会报名</h1>');
    writeFileSync(join(site, 'style.css'), 'h1{color:#333}');
    writeFileSync(join(site, '.env'), 'SECRET_TOKEN=do-not-publish');
    const before = posts().length;
    let sentBeforeAnswer = null;
    const ev = await run(sid('work'), '把工作区里的 book-club 文件夹发布成网页,发我链接。', 240_000, { approvalMode: 'full-auto' }, undefined,
      () => { sentBeforeAnswer = posts().length - before; return 'approve'; });
    const ask = ev.approvalList.find((a) => a.name === 'publish_web_page');
    const mine = posts().slice(before);
    const files = mine[0] ? JSON.parse(mine[0].body).files.map((f) => f.path).sort() : [];
    const url = mine[0] ? cloud.urlFor(JSON.parse(mine[0].body).slug) : '';
    const linked = !!url && ev.content.includes(url);
    // 卡上那句按界面语言渲染的结构化版(10-24):键对、slug 就是发出去的那个
    const i18n = ask?.previewI18n?.key === 'approval.preview.webPublish' && !!mine[0] && ask.previewI18n.vars?.slug === JSON.parse(mine[0].body).slug;
    leg('工作会话发布文件夹(完全通行):照样弹卡,批准后只发一次,不带 .env,回复给链接,卡带本地化预览',
      !ev.error && !!ask && ask.reason === 'always' && sentBeforeAnswer === 0 && mine.length === 1 && files.join(',') === 'index.html,style.css' && linked && i18n,
      ev.error || `${ask ? `弹卡(原因 ${ask.reason})` : '✗ 没弹卡'};批准前已发 ${sentBeforeAnswer ?? '-'} 次;共发 ${mine.length} 次;文件 [${files.join(', ')}];回复${linked ? '带了链接' : `✗ 没带链接 ${url}`};预览 ${ask?.previewI18n ? JSON.stringify(ask.previewI18n) : '✗ 没有'}`, ev);
  }
  // 2. Chat session: the model writes the page into the session sandbox, then publishes it from there.
  {
    const before = posts().length;
    const ev = await run(sid('chat'), '帮我写一个最简单的个人名片网页(名字写「林一」,职业写「插画师」),然后直接发布出去,把链接给我。', 300_000,
      { ...CHAT, approvalMode: 'full-auto' }, undefined, () => 'approve');
    const mine = posts().slice(before);
    const body = mine[0] ? JSON.parse(mine[0].body) : null;
    const html = body?.files.find((f) => f.path === body.entry);
    const page = html ? Buffer.from(html.content_b64, 'base64').toString('utf8') : '';
    const url = body ? cloud.urlFor(body.slug) : '';
    leg('聊天会话:先写进会话工作区再发布,发出去的入口页就是写的那页,回复给链接',
      !ev.error && called(ev, 'publish_web_page') && mine.length === 1 && page.includes('林一') && ev.content.includes(url),
      ev.error || `${called(ev, 'publish_web_page') ? '发布成功' : `✗ 发布没成(${ev.toolResults.filter((r) => r.name === 'publish_web_page').map((r) => (r.full || '').slice(0, 80)).join(' / ') || '没调'})`};发了 ${mine.length} 次;入口页${page.includes('林一') ? '含「林一」' : '✗ 不是写的那页'};回复${url && ev.content.includes(url) ? '带了链接' : '✗ 没带链接'}`, ev);
  }
  // 3. "Which pages have I published?" — read-only: forsion_account web_pages, no card, both links in the reply.
  {
    const ev = await run(sid('list'), '我在 Forsion 上发布过哪些网页?把链接列给我。', 180_000, CHAT, undefined, () => 'reject');
    const urls = [...cloud.apps.keys()].map((s) => cloud.urlFor(s));
    const all = urls.length >= 2 && urls.every((u) => ev.content.includes(u));
    leg('「我发布过哪些网页」:只读,不弹卡,列出全部链接', !ev.error && called(ev, 'forsion_account') && !ev.approvalList.length && all,
      ev.error || `${called(ev, 'forsion_account') ? '调了 forsion_account' : '✗ 没调 forsion_account'};弹卡 ${ev.approvalList.length} 次;链接 ${urls.filter((u) => ev.content.includes(u)).length}/${urls.length}`, ev);
  }

  // 4. webpublishreal only (cloud.connect = a real Connect server behind the front): every page the legs published opens
  //    through its public link — shell 200, content served sandboxed and is the page that was sent — and the server's own
  //    list agrees with what the legs saw. Against the fake cloud this leg does not exist (nothing is served there).
  if (cloud.connect) {
    const rows = [];
    for (const [slug, b] of cloud.apps) {
      const url = cloud.urlFor(slug);
      const shell = await fetch(url).catch(() => null);
      const content = await fetch(`${url}__content/`).catch(() => null);
      const html = content ? await content.text() : '';
      const sent = Buffer.from(b.files.find((f) => f.path === b.entry)?.content_b64 || '', 'base64').toString('utf8');
      rows.push({ slug, shell: shell?.status, content: content?.status, csp: /sandbox/.test(content?.headers.get('content-security-policy') || ''), same: !!html && html === sent });
    }
    const listed = await fetch(`${cloud.url}/api/connect/apps`, { headers: { Authorization: `Bearer ${cloud.token}` } }).then((r) => r.json()).catch(() => null);
    const slugs = (listed?.apps || []).map((a) => a.slug).sort();
    const ok = rows.length >= 2 && rows.every((r) => r.shell === 200 && r.content === 200 && r.csp && r.same) && slugs.join() === [...cloud.apps.keys()].sort().join();
    legs.push({ name: '真 Connect:发出去的每一页都能经公开链接打开(壳页 200、内容带 CSP sandbox 且就是发的那页),服务端列表与之一致', ok,
      why: `${rows.map((r) => `${r.slug} 壳 ${r.shell} / 内容 ${r.content}${r.csp ? ' sandbox' : ' ✗无 sandbox'}${r.same ? '' : ' ✗内容不符'}`).join(';')};服务端列表 [${slugs.join(', ')}] 名额 ${listed?.used}/${listed?.limit}`,
      ev: { content: JSON.stringify({ rows, listed: listed && { ...listed, apps: slugs } }), toolCalls: [], usages: [] } });
  }

  const bad = legs.filter((l) => !l.ok);
  return {
    ok: !bad.length,
    detail: legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: legs.map((l, i) => `【${i + 1} ${l.name}】\n${l.ev.content}`).join('\n\n'),
    toolCalls: legs.flatMap((l) => l.ev.toolCalls),
    tokens: legs.reduce((a, l) => a + (l.ev.usages?.reduce((x, u) => x + (Number(u.prompt) || 0) + (Number(u.completion) || 0), 0) || 0), 0) || null,
    webPublishLegs: legs.map((l) => ({ name: l.name, ok: l.ok, why: l.why, tools: l.ev.toolCalls, approvals: l.ev.approvalList })),
    cloudRequests: cloud.seen.map((r) => `${r.method} ${r.path}`),
  };
}
