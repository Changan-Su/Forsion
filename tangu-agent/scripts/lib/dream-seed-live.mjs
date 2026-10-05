/** Opt-in live probe: Dream on a memory of realistic size, repeated N rounds from the same seed.
 *  The stock `dream` scenario feeds it two facts, which every thinking level gets right; this one is for
 *  measuring how often a consolidation completes and whether it keeps / promotes / discards the right lines. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Existing memory. `keys` must still be somewhere in MEMORY afterwards (a merge may reword, it may not lose them).
// The first 20 are the default tier (the dev default agent holds 18 entries, 10-05); 40 is the stress tier.
const SEED = [
  ['个人项目的本地存储一律用 SQLite,不上 Postgres。', ['SQLite']],
  ['包管理器只用 pnpm,不要 npm 或 yarn。', ['pnpm']],
  ['所有项目统一用 pnpm 管理依赖(不用 npm / yarn)。', ['pnpm']],
  ['提交信息用中文写,首行不超过 50 个字。', ['50']],
  ['代码评审一位 reviewer 批准即可合并。', ['reviewer']],
  ['发布窗口是每周二上午;季度最后一周冻结,不发布。', ['周二', '冻结']],
  ['时区按 Asia/Shanghai 算,日程里的时间都是北京时间。', ['Asia/Shanghai']],
  ['编辑器用 Neovim,键位是 Colemak 布局,给快捷键建议时别按 QWERTY。', ['Neovim', 'Colemak']],
  ['终端用 Ghostty,字体 JetBrains Mono。', ['Ghostty', 'JetBrains']],
  ['测试框架用 vitest;只有 legacy/ 目录下的老代码还在用 jest。', ['vitest', 'legacy', 'jest']],
  ['Python 版本固定 3.12,用 uv 建虚拟环境,不用 conda。', ['3.12', 'uv']],
  ['Docker 镜像一律基于 debian:bookworm-slim,不要 alpine(musl 出过问题)。', ['bookworm', 'alpine']],
  ['主力云在阿里云杭州区,对象存储桶名前缀是 fs-prod-。', ['fs-prod-']],
  ['CI 里 lint 失败不阻塞合并,但类型检查失败必须阻塞。', ['lint', '类型检查']],
  ['文档用简体中文写,代码注释用英文。', ['注释']],
  ['不喜欢回答里用 emoji,也不要用感叹号。', ['emoji']],
  ['回答里不要出现 emoji 和感叹号。', ['emoji']],
  ['周五下午不安排上线(2025 年 3 月那次周五事故之后定的)。', ['周五', '2025']],
  ['数据库迁移文件命名格式是 YYYYMMDDHHmm_描述.sql。', ['YYYYMMDDHHmm']],
  ['API 错误响应统一用 RFC 7807 的 problem+json。', ['7807']],
  ['日志库用 pino,生产环境级别 info,本地 debug。', ['pino']],
  ['前端状态管理用 Zustand,不引入 Redux。', ['Zustand']],
  ['组件库用 Radix UI 加自写样式,不用 Ant Design。', ['Radix']],
  ['图标只用 Lucide,线宽 1.5。', ['Lucide']],
  ['所有金额在后端用整数分存储,不用浮点。', ['整数']],
  ['密钥放 1Password,由 op run 注入环境变量,不落 .env 文件。', ['1Password', 'op run']],
  ['Git 主分支叫 main,发布分支命名 release/x.y。', ['release/']],
  ['回答先给结论再给理由,超过三段要加小标题。', ['结论']],
  ['服务端口约定:API 8787,管理后台 8788,文档站 8790。', ['8787', '8788', '8790']],
  ['Redis 只做缓存和限流,不存业务数据。', ['Redis']],
  ['移动端最低支持 iOS 17 和 Android 13。', ['iOS 17', 'Android 13']],
  ['性能预算:首屏 JS 不超过 180KB(gzip 后)。', ['180']],
  ['女儿叫小满,每周六上午有游泳课,那个时段不要排事情。', ['小满', '游泳']],
  ['咖啡因敏感,下午 3 点后不喝咖啡;建议提神方法时别推荐咖啡。', ['咖啡']],
  ['正在准备 2026 年 11 月的 JLPT N2 考试,每天晚上学日语。', ['N2']],
  ['读书笔记放在 Notes/Reading/ 下,文件名用「作者 - 书名.md」。', ['Notes/Reading']],
  ['画图用 Excalidraw,导出 SVG 而不是 PNG。', ['Excalidraw', 'SVG']],
  ['开会纪要模板:结论 / 待办(带负责人和日期)/ 未决问题。', ['未决']],
  ['对外邮件用英文写,署名用全名拼音。', ['拼音']],
  ['备份策略:每天 03:00 快照,保留两周;每月 1 号的保留一年。', ['03:00', '一年']],
];

// What the user says in the source conversation. Everything below except the Fastify line is in it.
const SAID = [
  '顺便同步几件以后都算数的事,你知道就行,不用现在记:',
  '1) 团队改规矩了:合并前必须有 CODEOWNERS 里的两位 reviewer 批准,以前是一位就行。',
  '2) 我的工作机换成了 16 寸 MacBook Pro(M5 Max),旧的 Intel 机器不用了。',
  '3) 以后给我写 shell 脚本一律用 zsh,不要 bash。',
  '4) 每周三 14:00 到 16:00 我固定不开会,留给深度工作。',
  '另外今天下午我把登录页的验证码 bug 修完了,明天再排查支付回调那个问题。个人项目本地存储用 SQLite 这点你已经知道。',
  '这条消息只需要回一句「知道了」。',
].join('\n');

// Inbox candidates, as a judge would have left them. kind: good = stated and durable; dup = already in memory;
// temp = said but only today's status; unsupported = never said.
const CANDIDATES = [
  ['good', '合并前必须有 CODEOWNERS 里的两位 reviewer 批准(此前一位即可)。', 'CODEOWNERS'],
  ['good', '工作机是 16 寸 MacBook Pro(M5 Max),旧的 Intel 机器已停用。', 'M5'],
  ['good', '给用户写 shell 脚本一律用 zsh,不用 bash。', 'zsh'],
  ['good', '每周三 14:00–16:00 是固定的深度工作时间,不安排会议。', '周三'],
  ['dup', '个人项目本地数据库用 SQLite。', 'SQLite'],
  ['temp', '今天下午修完了登录页的验证码 bug。', '验证码'],
  ['temp', '明天要排查支付回调的问题。', '支付回调'],
  ['unsupported', '计划下个月把后端从 Express 迁到 Fastify。', 'Fastify'],
];

export async function dreamSeedLive({ run, api, until, home, OUT, MODEL, AGENT_CONFIG, rounds, entries, timeoutMs }) {
  const slug = 'live-dreamseed';
  const seed = SEED.slice(0, Math.max(1, Math.min(SEED.length, entries)));
  const seedText = seed.map(([fact]) => `- ${fact}`).join('\n');
  await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: 'Dream Seed', systemPrompt: "You are a concise assistant. Reply in the user's language." }) });
  // The judge must stay out of this: its own candidates would make the inbox differ from round to round.
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { enabled: true, modelId: MODEL, everyRounds: 50, firstRoundTrigger: false, mode: 'independent' } }) });
  const dream = `/agent/agents/${slug}/memory/dream`;
  // enabled:false only stops the automatic trigger; the POST below is the same manual run as the panel's "Run now".
  await api(dream, { method: 'PUT', body: JSON.stringify({ enabled: false, modelId: MODEL, ...(timeoutMs ? { timeoutMs } : {}) }) });
  const cfg = { ...AGENT_CONFIG, agentSlug: slug };
  const sid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: 'Dream seed source', model_id: MODEL, agent_config: cfg }) })).session.id;
  const said = await run(sid, SAID, 180_000, cfg);
  if (said.error) return { ok: false, detail: `来源对话没跑成:${said.error}`, output: said.content };

  const memoryOf = async () => api(`/agent/agents/${slug}/memory`);
  const rawPath = join(home, 'agents', slug, '.memory-raw.md');
  mkdirSync(join(home, 'agents', slug), { recursive: true });
  const rows = [];
  for (let i = 0; i < rounds; i++) {
    // Same seed every round. A different date per round gives the candidates fresh ids (an id is the hash of its line),
    // otherwise round 2 would find them already processed.
    const before = await memoryOf();
    await api(`/agent/agents/${slug}/memory`, { method: 'PUT', body: JSON.stringify({ expectedVersion: before.version, content: seedText }) });
    const day = `2026-09-${String(i + 1).padStart(2, '0')}`;
    writeFileSync(rawPath, CANDIDATES.map(([, text]) => `- [${day} s:${sid}] ${text}`).join('\n') + '\n');
    const t0 = Date.now();
    await api(dream, { method: 'POST', body: '{}' });
    const st = await until(async () => { const d = await api(dream); return d.status && !d.status.running && d.status.state !== 'idle' ? d.status : null; }, 200_000, 1500);
    const ms = Date.now() - t0;
    const content = String((await memoryOf()).content || '');
    const lines = content.split('\n').filter((l) => l.trim());
    const completed = st?.state === 'completed';
    const lost = completed ? seed.flatMap(([, keys]) => keys).filter((k, n, all) => all.indexOf(k) === n && !content.includes(k)) : [];
    const has = (kind) => CANDIDATES.filter(([k, , key]) => k === kind && content.includes(key)).map(([, , key]) => key);
    rows.push({
      round: i + 1, state: st?.state || 'timeout', detail: String(st?.detail || '').slice(0, 300), calls: st?.calls ?? null, ms,
      entriesBefore: seed.length, entriesAfter: lines.length, lost,
      promoted: completed ? has('good') : [], tempKept: completed ? has('temp') : [], unsupportedKept: completed ? has('unsupported') : [],
      sqliteLines: lines.filter((l) => l.includes('SQLite')).length, memory: content,
    });
  }
  writeFileSync(join(OUT, 'dreamseed-evidence.json'), JSON.stringify({ entries: seed.length, candidates: CANDIDATES, said: said.content, rounds: rows }, null, 2));
  const done = rows.filter((r) => r.state === 'completed');
  const clean = done.filter((r) => !r.lost.length && !r.unsupportedKept.length);
  const sum = (f) => done.reduce((n, r) => n + f(r), 0);
  const med = (xs) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
  return {
    // Green = every round finished, no existing fact lost, the never-said line not promoted.
    // Promoting the four stated facts and dropping today's status are counted, not gated.
    ok: clean.length === rows.length,
    detail: [
      `已有 ${seed.length} 条 + 候选 ${CANDIDATES.length} 条,${rows.length} 轮`,
      `整理完成 ${done.length}/${rows.length}${done.length < rows.length ? `(没完成的:${rows.filter((r) => r.state !== 'completed').map((r) => `第 ${r.round} 轮 ${r.state} ${r.detail.slice(0, 90)}`).join(';')})` : ''}`,
      `完成的里面:丢了已有事实的 ${done.filter((r) => r.lost.length).length} 轮${sum((r) => r.lost.length) ? `(${done.flatMap((r) => r.lost).join(',')})` : ''}`,
      `没说过的那条被记进去 ${done.filter((r) => r.unsupportedKept.length).length} 轮`,
      `说过的 4 条长期事实记进去 ${sum((r) => r.promoted.length)}/${done.length * 4}`,
      `只是当天进度的 2 条被记进去 ${sum((r) => r.tempKept.length)}/${done.length * 2}`,
      `整理后条数 ${done.map((r) => r.entriesAfter).join('/') || '-'}`,
      `每轮用时中位数 ${(med(rows.map((r) => r.ms)) / 1000).toFixed(1)} 秒,最长 ${(Math.max(...rows.map((r) => r.ms)) / 1000).toFixed(1)} 秒`,
    ].join(';'),
    output: rows.map((r) => `【第 ${r.round} 轮 ${r.state},${(r.ms / 1000).toFixed(1)} 秒,${r.calls ?? '?'} 次调用】${r.detail}\n${r.memory}`).join('\n\n'),
  };
}
