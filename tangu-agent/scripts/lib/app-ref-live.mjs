/** Opt-in live scenario: app / window references in chat.
 *
 *  The desktop composer can insert `[[app://<bundle id>|<app name>]]` and `[[window://<bundle id>|<window title>]]`
 *  (contract: desktop/shared/appRefs.ts). They reach the model verbatim, on a leading line of references or inline.
 *  Four legs, each one message in a fresh session:
 *    A  asked    — app on the leading line, window inline, and the user asks for "the same form" in the reply;
 *    B  plain    — both inline, nothing said about how to write the reply;
 *    C  docked   — the message carries no reference at all, only the side-panel tag `<forsion-app … bundleId=… />`,
 *                  and the user asks for something they can click. The form has to come from the system prompt and the
 *                  id from the tag — the leg an engine without APP_REF_SECTION cannot pass;
 *    D  lone     — a window reference alone on the leading line, then "summarise this".
 *  What is judged on every leg:
 *    · the reference was not treated as a note / file / past session (no such tool got the token, the title or the
 *      bundle id; no notes-vault tool at all), and the reply does not talk about a note or file of that name;
 *    · every reference the reply writes is one it was given (or, in C, could build from the tag), character for
 *      character, and none of them sits in a code span or a code block (in code the chat shows raw text, not a chip).
 *  A and C also require the reference in the reply. B and D only record whether it wrote one — the prompt allows it
 *  there, it does not demand it. The harness has no desktop-control tools, so the honest answer is "I cannot see that
 *  window"; that is recorded too.
 *  Shell commands that ask for approval are refused: a model that reaches for osascript must not read the real apps
 *  on the machine running the harness. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP = '[[app://com.tencent.xinWeChat|微信]]';
/** 标题里是 en dash(U+2013),写成转义:消息和判据必须逐字节是同一个字符。 */
export const WIN = '[[window://com.google.Chrome|Linear – Pricing]]';
const DOCK_APP = '[[app://com.figma.Desktop|Figma]]';
const DOCK_WIN = '[[window://com.figma.Desktop|落地页 v3]]';
const CHAT_WIN = '[[window://com.tencent.xinWeChat|产品群(128)]]';
/** promptSections.ts 的 APP_REF_SECTION 的标题行(台架是 mjs,不从 dist 引:基线的 dist 里没有这个导出)。 */
export const APP_REF_HEADING = '## App & Window References';

/** given = 这条腿里模型可以写的引用;must = 回复里至少要有其中一条(空 = 只记不判);names = 进了读文件 / 笔记 / 会话工具的参数就算认错的名字。 */
export const LEGS = [
  { tag: 'asked', title: 'A 明说用同样的写法', given: [APP, WIN], must: [WIN], names: ['Linear', 'Pricing', 'com.google.Chrome', 'xinWeChat', '微信'],
    message: `${APP}\n把 ${WIN} 里的定价抄一份给我,做不到就直说,并在回复里用同样的写法提到这扇窗口` },
  { tag: 'plain', title: 'B 没明说', given: [APP, WIN], must: [], names: ['Linear', 'Pricing', 'com.google.Chrome', 'xinWeChat', '微信'],
    message: `我想把 ${WIN} 里的定价表发到 ${APP} 的一个群里。你能直接看到这扇窗口里的内容吗?不能的话告诉我该怎么把内容给你。` },
  { tag: 'docked', title: 'C 只有侧边面板的标签', given: [DOCK_APP, DOCK_WIN], must: [DOCK_APP, DOCK_WIN], names: ['Figma', 'com.figma', '落地页'],
    message: '<forsion-app app="Figma" bundleId="com.figma.Desktop" pid="4242" windowId="77" title="落地页 v3" />\n我等会儿还要回到这扇窗口。它是哪个应用的哪扇窗口?回复里提到它的时候,写成我在聊天里能直接点过去的那种引用。' },
  { tag: 'lone', title: 'D 只有一条窗口引用', given: [CHAT_WIN], must: [], names: ['产品群', 'xinWeChat', '微信'],
    message: `${CHAT_WIN}\n总结一下这个` },
];

/** 读文件 / 笔记 / 过去会话的工具:引用的名字进了它们的参数 = 被当成了笔记或文件。 */
const READERS = /^(read_file|read_document|list_dir|list_files|view_image|view_video|search_files|glob_files|read_session|search_sessions|read_log|transcribe_audio)$/;
const NOTES = /^amadeus_/;
/** 只是「说话 / 记事」的工具:参数里原样引用用户的话不算把引用当路径。 */
const SPEAKING = /^(ask_user|todo_write|log_event|remember|manage_human|manage_harness|delegate|inbox_send)$/;
const SCHEME = /\b(?:app|window):\/\//;
/** 回复里长得像引用、却不是给过的那几条:带 `://` 的,或 `[[app:…]]` / `[[window:…]]` 这类自己编的写法(基线 10-13 实测写过 `[[app:com.figma.Desktop/window:77|…]]`)。 */
const LOOKALIKE = /\b(?:app|window):\/\/|\[\[\s*(?:app|window)\s*:/i;

/** 模型给的参数是 JSON 原文,`/` 和非 ASCII 可能带转义:解析后再串起来,比较才不看转义写法。 */
const flatArgs = (a) => { try { return JSON.stringify(JSON.parse(String(a || '{}'))); } catch { return String(a || ''); } };

/** 去掉围栏代码块和行内代码。 */
export const stripCode = (text) => String(text || '')
  .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g, '$1')
  .replace(/``[^\n]*?``|`[^`\n]*`/g, '');

/** 回复里有没有把引用说成笔记 / 文件。先去掉否定句式(「不是笔记也不是文件」是说对了)。 */
const noteClaim = (text) => {
  const s = text.replace(/(不是|并非|而非|而不是|不属于|rather than|\bnot\b|\bisn['’]t\b)[^。,，;；.\n]{0,24}/gi, '');
  return /笔记|知识库|\bvault\b|\bnotes?\b/i.test(s)
    || /(读取|读了|读到|打开了|找到了?|找不到|没找到|未找到|没有找到|搜索了?)[^。\n]{0,16}(文件|文档)/.test(s)
    || /(文件|文档)[^。\n]{0,10}(不存在|找不到|没找到|未找到)/.test(s)
    || /\b(file|document)\b[^.\n]{0,24}\b(not found|does not exist|doesn['’]t exist|missing)\b/i.test(s);
};

/**
 * 一条腿的判定。返回 { checks, gating, fails, ok }:checks 里每一项都记,只有 gating 里的进 ok。
 */
export function judgeAppRef({ content, toolArgs, systemPrompt }, leg) {
  const raw = String(content || '');
  const text = stripCode(raw);
  const calls = (toolArgs || []).map((c) => ({ name: String(c.name || ''), args: flatArgs(c.arguments) }));
  const passedRef = calls.filter((c) => !SPEAKING.test(c.name) && SCHEME.test(c.args));
  const asNote = calls.filter((c) => NOTES.test(c.name) || (READERS.test(c.name) && leg.names.some((n) => c.args.includes(n))));
  const rest = leg.given.reduce((s, t) => s.split(t).join(''), text);
  const count = (s) => (s.match(/(?:app|window):\/\//g) || []).length;
  const checks = {
    section: String(systemPrompt || '').includes(APP_REF_HEADING), // 段真的进了系统提示(与模型配不配合无关)
    toolsClean: passedRef.length === 0, // 没有工具拿到 app:// / window://
    notAsNote: asNote.length === 0, // 没去笔记 / 文件 / 过去会话里找这个名字
    tokenExact: (leg.must.length ? leg.must : leg.given).some((t) => text.includes(t)), // 代码之外有一字不差的引用
    tokenClean: !LOOKALIKE.test(rest), // 代码之外没有改过的 / 自己编的引用
    noneInCode: count(raw) === count(text), // 没有哪一处写在代码里
    noNoteClaim: !noteClaim(text),
    honest: /做不到|无法|没法|不能|没办法|没有办法|看不到|看不见|读不到|拿不到|cannot|can['’]t|unable/i.test(text), // 只记不判
  };
  const gating = ['section', 'toolsClean', 'notAsNote', ...(leg.must.length ? ['tokenExact'] : []), 'tokenClean', 'noneInCode', 'noNoteClaim'];
  const fails = gating.filter((k) => !checks[k]);
  return { checks, gating, fails, ok: fails.length === 0, wrote: leg.given.filter((t) => text.includes(t)), passedRef: passedRef.map((c) => c.name), asNote: asNote.map((c) => c.name) };
}

const LABEL = { section: '提示词里有这一段', toolsClean: '没把引用交给工具', notAsNote: '没当成笔记 / 文件 / 会话去找', tokenExact: '回复里有原样的引用', tokenClean: '没有改写或自造的引用', noneInCode: '没写进代码格式', noNoteClaim: '没说成笔记 / 文件' };

export async function appRefLive({ run, OUT, tokensOf, ttft }) {
  const legs = [];
  for (const leg of LEGS) {
    const rejected = [];
    // 要批的 shell 一律拒(见文件头);别的照旧代批。
    const ev = await run(`live-appref-${leg.tag}-${Date.now()}`, leg.message, 240_000, { debugSystemPrompt: true }, 'desktop/live-harness',
      (p) => { if (/^(run_bash|run_background)$/.test(String(p.name))) { rejected.push(String(p.arguments || '').slice(0, 200)); return 'reject'; } return undefined; });
    legs.push({ leg, ev, verdict: ev.error || !ev.done ? null : judgeAppRef(ev, leg), rejected });
  }
  const line = (l) => {
    if (!l.verdict) return `${l.leg.title}:run 出错(${l.ev.error || '没有 done'})`;
    const c = l.verdict.checks;
    const extra = [...(l.leg.must.length ? [] : [`自己写了引用:${c.tokenExact ? '是' : '否'}`]), `说明看不到:${c.honest ? '是' : '否'}`];
    return `${l.leg.title}:${l.verdict.gating.map((k) => `${LABEL[k]}${c[k] ? '✓' : '✗'}`).join(' ')};不计入的:${extra.join(',')};写出的引用 ${l.verdict.wrote.length};工具 ${l.ev.toolCalls.join(',') || '无'}${l.verdict.passedRef.length ? `(拿到引用的:${l.verdict.passedRef.join(',')})` : ''}${l.verdict.asNote.length ? `(当笔记 / 文件找的:${l.verdict.asNote.join(',')})` : ''}${l.rejected.length ? `;拒掉 ${l.rejected.length} 条 shell` : ''}`;
  };
  writeFileSync(join(OUT, 'appref-evidence.json'), JSON.stringify(legs.map((l) => ({
    leg: l.leg.tag, title: l.leg.title, message: l.leg.message, error: l.ev.error, content: l.ev.content,
    toolCalls: (l.ev.toolArgs || []).map((c) => ({ name: c.name, arguments: c.arguments })),
    rejectedShell: l.rejected, ...(l.verdict || {}),
  })), null, 2));
  return {
    ok: legs.every((l) => l.verdict?.ok),
    detail: legs.map(line).join(' ‖ '),
    checks: Object.fromEntries(legs.map((l) => [l.leg.tag, l.verdict?.checks ?? null])),
    output: legs.map((l) => `--- ${l.leg.title} ---\n用户:${l.leg.message}\n\n回复:${l.ev.content || `(${l.ev.error || '空'})`}`).join('\n\n'),
    ttftMs: ttft(legs[0].ev), tokens: legs.reduce((a, l) => a + (tokensOf(l.ev) || 0), 0) || null, toolCalls: legs.flatMap((l) => l.ev.toolCalls),
  };
}

/** --selftest 的行:[名字, 得到, 应为]。每条判据配一个该红的输入。 */
export function appRefSelftest() {
  const sys = `x\n${APP_REF_HEADING}\ny`;
  const [asked, plain, docked, lone] = LEGS;
  const call = (name, args) => ({ name, arguments: JSON.stringify(args) });
  const j = (content, toolArgs = [], leg = asked, systemPrompt = sys) => judgeAppRef({ content, toolArgs, systemPrompt }, leg);
  const good = `我看不到 ${WIN} 里的内容,没法替你抄。`;
  return [
    ['appref 原样引用、没调工具', j(good).ok, true],
    ['appref 提示词里没有这一段(负对照)', j(good, [], asked, 'x').fails.join(), 'section'],
    ['appref 引用写在行内代码里(负对照)', j(`我看不到 \`${WIN}\` 里的内容。`).fails.join(), 'tokenExact,noneInCode'],
    ['appref 引用写在代码块里(负对照)', j(`我看不到:\n\n\`\`\`\n${WIN}\n\`\`\`\n`).fails.join(), 'tokenExact,noneInCode'],
    ['appref 代码外一处、代码里又一处(负对照)', j(`${good}写法是 \`${WIN}\`。`).fails.join(), 'noneInCode'],
    ['appref en dash 换成了连字符(负对照)', j('我看不到 [[window://com.google.Chrome|Linear - Pricing]] 里的内容。').fails.join(), 'tokenExact,tokenClean'],
    ['appref 自己编了一个应用标识(负对照)', j(`${good}可以先切到 [[app://com.linear.app|Linear]]。`).fails.join(), 'tokenClean'],
    ['appref 只剩一层方括号(负对照)', j('我看不到 [window://com.google.Chrome|Linear – Pricing] 里的内容。').fails.join(), 'tokenExact,tokenClean'],
    ['appref 没提这扇窗口(明说时须红)', j('我做不到。').fails.join(), 'tokenExact'],
    ['appref 没提这扇窗口(没明说时不判)', j('我看不到那扇窗口。', [], plain).ok, true],
    ['appref 把引用交给 read_file(负对照)', j(good, [call('read_file', { path: 'window://com.google.Chrome' })]).fails.join(), 'toolsClean,notAsNote'],
    ['appref 转义写法的引用交给 web_fetch(负对照)', j(good, [{ name: 'web_fetch', arguments: '{"url":"app:\\/\\/com.tencent.xinWeChat"}' }]).fails.join(), 'toolsClean'],
    ['appref 拿标题去翻过去的会话(负对照)', j(good, [call('search_sessions', { query: 'Linear Pricing' })]).fails.join(), 'notAsNote'],
    ['appref 拿转义的中文名去搜文件(负对照)', j(good, [{ name: 'search_files', arguments: '{"pattern":"\\u5fae\\u4fe1"}' }]).fails.join(), 'notAsNote'],
    ['appref 去翻笔记库(负对照)', j(good, [call('amadeus_list_notes', {})]).fails.join(), 'notAsNote'],
    ['appref 看一眼工作目录不算', j(good, [call('list_dir', { path: '.' })]).ok, true],
    ['appref 读浏览器标签不算', j(good, [call('browser_tabs', {})]).ok, true],
    ['appref 向用户提问时引用原话不算', j(good, [call('ask_user', { question: `要我看 ${WIN} 吗?` })]).ok, true],
    ['appref 说没找到这篇笔记(负对照)', j(`没有找到名为「Linear – Pricing」的笔记。${WIN}`).fails.join(), 'noNoteClaim'],
    ['appref 说文件不存在(负对照)', j(`${WIN} 这个文件不存在。`).fails.join(), 'noNoteClaim'],
    ['appref 说它不是笔记(说对了,不算)', j(`${WIN} 是一扇窗口,不是笔记也不是文件,我看不到里面。`).ok, true],
    ['appref 标签里的应用写成引用', j(`这是 ${DOCK_APP} 的窗口 ${DOCK_WIN}。`, [], docked).ok, true],
    ['appref 标签那条腿只写了窗口也算', j(`这是 Figma 的 ${DOCK_WIN}。`, [], docked).ok, true],
    ['appref 标签那条腿写成普通链接(负对照)', j('这是 [Figma 的「落地页 v3」](window://com.figma.Desktop)。', [], docked).fails.join(), 'tokenExact,tokenClean'],
    ['appref 标签那条腿自己编了一种写法(负对照,基线的原话)', j('这是 **Figma** 里的 **“落地页 v3”** 窗口:[[app:com.figma.Desktop/window:77|落地页 v3]]', [], docked).fails.join(), 'tokenExact,tokenClean'],
    ['appref 标签那条腿没写引用(负对照)', j('这是 Figma 的「落地页 v3」窗口,聊天里没法做成可点的。', [], docked).fails.join(), 'tokenExact'],
    ['appref 标签那条腿把 pid 塞进引用(负对照)', j('这是 [[window://com.figma.Desktop#77|落地页 v3]]。', [], docked).fails.join(), 'tokenExact,tokenClean'],
    ['appref 标签那条腿改了窗口标题(负对照)', j('这是 [[window://com.figma.Desktop|落地页 v3 – Figma]]。', [], docked).fails.join(), 'tokenExact,tokenClean'],
    ['appref 单条引用:说看不到、没写引用也算', j('我看不到这扇窗口里的聊天内容。', [], lone).ok, true],
    ['appref 单条引用:拿群名去翻过去的会话(负对照)', j('我看不到。', [call('search_sessions', { query: '产品群' })], lone).fails.join(), 'notAsNote'],
  ];
}
