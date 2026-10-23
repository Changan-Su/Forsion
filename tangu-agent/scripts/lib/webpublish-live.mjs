/** Opt-in live probe (`--only webpublish`): can the model publish a web page through publish_web_page, from a work session
 *  (host files) and from a chat session (files it writes into the session sandbox), with the per-call approval card, and
 *  can it list what was published (forsion_account section web_pages)?
 *
 *  The engine's cloud URL points at the harness's fake Forsion cloud (lib/account-live.mjs), which keeps the published
 *  pages in memory and answers like server microserver/connect (publicUrl on publish, publicBase on list).
 *  Negative controls (run them when touching this): drop 'publish_web_page' from CHAT_PRESET_DEFERRED → leg 2 goes red
 *  (the chat face cannot publish); in webPublish.ts publish(), skip the sandbox branch (always resolvePath) → leg 2 goes red
 *  (the chat sandbox's files are not on the engine's cwd). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    leg('工作会话发布文件夹(完全通行):照样弹卡,批准后只发一次,不带 .env,回复给链接',
      !ev.error && !!ask && ask.reason === 'always' && sentBeforeAnswer === 0 && mine.length === 1 && files.join(',') === 'index.html,style.css' && linked,
      ev.error || `${ask ? `弹卡(原因 ${ask.reason})` : '✗ 没弹卡'};批准前已发 ${sentBeforeAnswer ?? '-'} 次;共发 ${mine.length} 次;文件 [${files.join(', ')}];回复${linked ? '带了链接' : `✗ 没带链接 ${url}`}`, ev);
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
