/**
 * 项目记忆分层(常驻 + 详情 + 召回)—— live-harness 的 `projtiers` 场景(11-09,方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09 第二步 2b)。
 *
 * 每轮一个新 Agent「Pine」、一个新项目文件夹(git init 过,项目记忆按 git 根认)。项目记忆直接摆一份约 4900 字的 MEMORY.md
 * (常驻上限 4000),最老的两条在线外 —— 今天的注入超线时留最新的,最老的看不见:
 *   ① 约定「数据库迁移文件放 db/migrations/…」,问「迁移文件该放哪、怎么起名」【门:答出 db/migrations】
 *   ② 来龙去脉「2026-08 把消息队列从 RabbitMQ 换成 NATS,因为 ARM 上内存太高」,问「当初为什么把 RabbitMQ 换掉」【门:答出 ARM 或内存】
 * 有整理入口的引擎(2b)先整理一遍(后台模型 = 本次台架模型),整理完常驻要回到上限以内;没有入口的旧引擎(404)跳过整理直接问。
 * 不管整理把那两条留在常驻还是挪进详情,新会话都该答得出(常驻每轮给;详情按这句话召回)。两问都要求不调用工具,只看注入了什么。
 * 负对照 = 2a 的构建(项目记忆整份常驻、超线留最新的):两问都应答不出 → 红。
 * 种子、整理结果、整理前后的项目记忆、回答、系统提示 / 召回里有没有那两条,都存 `projtiers-evidence.json`。
 * 自检(不用模型):`node scripts/lib/projtiers-live.mjs`。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const CONVENTION = '数据库迁移文件放在 db/migrations/，文件名用「年月日时分_说明.sql」，已经合进 main 的迁移不许再改，只能另写一份新的。';
const DECISION = '2026-08 把消息队列从 RabbitMQ 换成了 NATS：RabbitMQ 在 ARM 服务器上常驻内存超过 2 GB，NATS 不到 200 MB。';
/** 最老的在前(MEMORY.md 一行一条)。除了上面两条,别的条目里不出现「迁移」「RabbitMQ」「数据库」,问句只对得上那两条。 */
export const FACTS = [
  CONVENTION,
  DECISION,
  '本地起开发环境用 make dev，它会先跑 docker compose up -d postgres redis，再起 API 和前端。',
  '前端代码在 web/，后端 API 在 server/api/，两边共用的类型定义在 packages/shared-types/。',
  '提交信息用英文，格式是 type(scope): summary，type 只用 feat / fix / chore / docs / refactor 这五种。',
  '跑后端测试前要先 export TZ=UTC，不然 server/api 里和时间有关的快照测试会在本机挂掉。',
  '2026-06 把前端从 Create React App 换到了 Vite，冷启动从 40 秒降到 3 秒，之后不再维护 webpack 配置。',
  '11-03 做到一半：订单导出接口写完了，还差分页和权限检查，下一步先补分页。',
  '前端组件一律用函数组件加 hooks，不许再新写 class 组件；样式用 CSS Modules，不用 styled-components。',
  '支付回调在 server/api/payments/webhook.ts，改它之前要先在 staging 上用测试商户号走一遍完整流程。',
  '2026-07 试过用 GraphQL 替换 REST，三周后放弃了：移动端缓存难做，和现有网关的鉴权也对不上。',
  '11-05 修完了购物车在 Safari 上不刷新的问题，已经合进 main，等下一次发版带出去。',
  'lint 用 pnpm lint，CI 里 lint 不过直接挂；本地提交前的钩子只跑改动过的文件。',
  '环境变量的模板在 .env.example，新增变量要同时写进模板和 docs/config.md 里的说明表。',
  '踩过的坑：Redis 连接池在测试里不关会让 jest 挂住不退出，afterAll 里一定要调 closeRedis()。',
  '2026-05 决定订单号改用 ULID 而不是自增 ID：多个区域同时写入时自增 ID 会撞，ULID 还能按时间排序。',
  '10-28 做完了商品搜索的拼音匹配，产品说下周再看一下排序权重。',
  '图片上传走对象存储，前端直传、拿后端签发的临时凭证；本地开发用 MinIO，地址 http://localhost:9000。',
  '发版从 release/* 分支打包，版本号写在根目录 package.json，打 tag 之前要先更新 CHANGELOG.md。',
  '2026-04 客服系统从自建工单换到了第三方平台，自建的那套代码留在 legacy/support/，只读不再改。',
  '11-06 和设计对过新首页的稿子，商品卡片的圆角改成 12px，还没开始做。',
  '日志统一用 pino，打日志时带上 requestId；不许用 console.log 留在提交里，lint 会拦。',
  '踩过的坑：pnpm install 之后如果 sharp 报找不到二进制，要 pnpm rebuild sharp，换了 Node 版本一定会遇到。',
  '2026-03 把部署从虚拟机挪到了 Kubernetes，起因是双十一那次扩容手工操作了两个小时。',
  'API 返回的错误统一是 { code, message }，code 用大写下划线，前端按 code 出文案，不直接显示 message。',
  '11-04 帮运营导了一次十月的退款明细，用的是临时脚本 scripts/tmp/refund-oct.ts，用完可以删。',
  '定时任务写在 server/jobs/，每个任务一个文件，用 node-cron 的表达式，时区一律按 Asia/Shanghai。',
  '2026-02 评估过把后端换成 Go，最后没换：团队里熟 Go 的只有一个人，重写的代价太大。',
  '端到端测试用 Playwright，放在 e2e/，跑之前要先 make seed 灌好测试数据。',
  '11-07 订单详情页的加载速度优化做了一半，接口合并完了，前端还没换成新接口。',
  '踩过的坑：本机 Docker 分配的内存少于 4 GB 时 Elasticsearch 会起不来，日志里只报 exit code 137。',
  '2026-01 项目从单仓多包改成了 pnpm workspace，原来各包自己的 node_modules 都删掉了。',
  '代码评审至少要一个人点同意才能合，改到 server/api/payments/ 的要两个人。',
  '11-02 和后端对齐了优惠券叠加的规则：同一类券不叠加，不同类最多叠两张，已经写进了需求文档。',
  '性能监控接的是 Sentry，前后端各一个项目，告警发到工作群的「线上告警」频道。',
  '2026-09 把搜索从 PostgreSQL 的全文检索换到了 Elasticsearch，原因是中文分词效果太差、模糊搜索太慢。',
  '10-30 支付宝的退款通知偶尔会重复推送，现在靠订单状态判重，还没找到根本原因。',
  '国际化文案放在 web/src/locales/，zh 和 en 两份必须同时加，CI 有检查两边键是否一致。',
  '11-08 写了一半的会员积分过期提醒，定时任务写好了，短信模板还在等审核。',
  '踩过的坑：在 macOS 上跑 make dev 如果 5432 端口被本机装的 Postgres 占着，容器起不来也不报错，要先停掉本机的。',
  '后台管理端在 admin/，用的是同一套 shared-types，但路由前缀是 /admin/api，鉴权走单独的管理员会话，不和用户登录态混用。',
  '2026-05 把短信服务商从 A 家换成了 B 家：A 家的海外号码到达率只有六成，B 家贵一点但能到九成以上，合同签了两年。',
  '10-29 给结算页加了地址自动补全，用的是地图服务的联想接口，免费额度每天一万次，超了会直接返回空。',
  '所有金额在后端一律用整数「分」存和算，只在前端展示时除以 100；不许用浮点数做金额运算，评审时见到就打回。',
  '踩过的坑：Next 的图片组件在 Safari 14 上不支持 avif，商品图要同时给 webp 兜底，不然老 iPhone 上一片空白。',
  '2026-04 讨论过要不要做小程序，结论是先不做：用户画像里九成是电脑端下单的企业采购，小程序带不来新用户。',
  '11-01 把首页的推荐位改成了按类目轮播，数据是运营在后台手配的，不走推荐算法，等下个季度再接算法。',
  '接口文档用 OpenAPI 写在 server/api/openapi.yaml，改接口要同时改这份文档，CI 会拿它生成前端的请求类型并比对。',
  '踩过的坑：jest 并行跑时共用一个测试库会互相踩数据，测试库按 worker 编号建，每个 worker 一份，名字带 JEST_WORKER_ID。',
  '2026-06 把文件下载从后端转发改成了对象存储的签名链接，后端出口流量一个月省了三分之二，链接有效期设为 10 分钟。',
  '10-31 做了一版发票抬头的模糊匹配，测试同学说同名公司会匹配错，暂时先关掉了，开关在 config/features.json 里。',
  '前端状态管理用 Zustand，一个领域一个 store，放在 web/src/stores/；不许把服务端数据塞进 store，服务端数据统一走 React Query。',
  '2026-07 和法务确认过：用户注销后订单数据要保留三年用于对账，但手机号和地址要在 30 天内脱敏，脚本在 server/jobs/anonymize.ts。',
  '踩过的坑：本地开 HTTPS 调试支付回调时，自签证书要加进系统钥匙串并且勾「始终信任」，只装进浏览器不够，回调方会握手失败。',
  '11-06 帮客服加了按手机号后四位查订单的入口，产品还在犹豫要不要限制每天的查询次数，先上线观察一周。',
  '2026-03 把用户头像从后端存储换成了第三方头像服务，后来因为对方限流又换回了自己的对象存储，换回来的代码在 PR 1287。',
  '代码里的功能开关统一读 config/features.json，新开关缺省关，上线一周没问题再删开关和旧代码，不许留超过一个月的开关。',
  '10-27 把商品详情页的评论区改成了懒加载，首屏请求数从 23 个降到了 14 个，但评论的数量统计还是同步取的。',
  '踩过的坑：Kubernetes 上的 Pod 默认时区是 UTC，日志时间和定时任务都要显式按 Asia/Shanghai 算，之前对账任务因此早跑了八小时。',
  '2026-08 对外开放的商家接口加了签名校验：每个请求带时间戳和 HMAC，五分钟以外的时间戳直接拒，密钥按商家分开发。',
  '11-08 给订单列表加了按状态筛选，下拉框里的状态名是写死的，等后端把状态字典接口做好再换。',
  '库存扣减在 server/api/inventory/，下单时先预占、支付成功才真扣，预占 15 分钟不付款自动释放，释放任务每分钟跑一次。',
  '2026-02 把邮件模板从后端拼字符串改成了 MJML，原因是 Outlook 里排版总是乱，现在模板放在 server/templates/mail/。',
  '踩过的坑：React Query 的缓存键里如果放了 Date 对象，每次渲染都会被当成新键，接口会被打爆，键里一律放时间戳数字。',
  '10-26 给后台加了导出 CSV 的按钮，数据量大于五万行时会超时，先在前端提示「请缩小时间范围」，异步导出还没做。',
  '分支命名用 feat/、fix/、chore/ 开头，后面跟工单号和两三个英文词，比如 feat/SHOP-412-coupon-stack。',
  '2026-09 决定把客服聊天记录只留 180 天：存储成本一年涨了四倍，法务确认过客服记录没有更长的留存要求。',
  '踩过的坑：Playwright 在 CI 的 Linux 镜像里缺中文字体，截图对比会因为方块字失败，镜像里要装 fonts-noto-cjk。',
  '11-05 改了一半的商品批量上架，Excel 解析做完了，校验规则还差 SKU 重复和价格为零这两条。',
  '对外的 Webhook 统一从 server/api/webhooks/ 发，失败按 1、5、30 分钟重试三次，三次都失败进死信表，后台能手动重发。',
  '2026-01 讨论过把前端拆成微前端，最后决定不拆：团队只有六个前端，拆了以后公共依赖的版本对齐反而更累。',
  '10-25 帮财务对了一次九月的账，差了 3 笔，最后查出是退款回调重复推送，已经手工冲正。',
  '踩过的坑：pnpm 的 workspace 协议版本在发包时不会自动替换，内部包要发到私有源之前先跑 pnpm -r publish 而不是 npm publish。',
  '公共的工具函数放在 packages/utils/，每个函数都要有单测；新增依赖要在周会上说一声，避免同类库装两个。',
  '2026-06 下单接口加了幂等键：前端生成 UUID 放在请求头 Idempotency-Key 里，后端按键缓存 24 小时的结果，防止双击下两单。',
  '11-07 和运营约了下周一过一遍双十二的活动配置，活动页的倒计时组件还没做。',
  '踩过的坑：本机 Node 版本必须和 .nvmrc 一致（现在是 22），用 20 跑会在 sharp 和 fetch 的行为上出各种怪问题。',
  '2026-04 把验证码从图形验证码换成了滑块验证，图形验证码被脚本识别率超过八成，换完以后注册机流量降了九成。',
  '10-30 新加了一个「最近浏览」模块，存在浏览器本地，不上传服务器，最多留 50 条。',
];
export const SEED = `${FACTS.join('\n')}\n`;

export const ASK = {
  convention: '这个项目的数据库迁移文件该放在哪个目录、文件名怎么起？一句话回答，直接回答，不要调用任何工具。',
  decision: '当初为什么把 RabbitMQ 换掉了？一句话回答，直接回答，不要调用任何工具。',
};

/** 项目记忆的目录名(和引擎 services/projectMemory.ts 的 memoryDirName 同一个算法):路径各段用 - 连 + 8 位哈希。
 *  台架只拿它定位种子写到哪;写完用 GET /agent/project-context 核对引擎看到的条目数,对不上就算台架出错,不算红。 */
export function memoryDirName(root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  let readable = root.split(/[\\/]+/).filter(Boolean).join('-').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^[.-]+|[. ]+$/g, '');
  while (Buffer.byteLength(readable) > 120) { const cut = readable.indexOf('-'); readable = cut >= 0 ? readable.slice(cut + 1) : [...readable].slice(1).join(''); }
  return `${readable || 'project'}-${hash}`;
}

/** 代码判的门:两问各答出线外那件事;有整理入口时整理要成、整理完常驻回到上限以内。 */
export function grade({ seeded, conventionReply, decisionReply, organize, error }) {
  const gates = {
    seeded: !!seeded,
    conventionAnswered: conventionReply.includes('db/migrations'),
    decisionAnswered: /ARM|内存/.test(decisionReply),
    ...(organize.available ? { organized: organize.status === 'organized', residentUnderLimit: Number.isFinite(organize.afterChars) && organize.afterChars <= organize.limit } : {}),
  };
  return { ok: !error && Object.values(gates).every(Boolean), gates };
}

export async function projTiersLive(h) {
  const { run, api, OUT, MODEL, home, workspace, rounds } = h;
  const cfg0 = await api('/agent/special/config');
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { ...(cfg0.historian || {}), modelId: MODEL } }) });
  const evidence = []; const outs = []; const tools = []; let passed = 0;
  const tryApi = async (path, init) => { try { return { ok: true, body: await api(path, init) }; } catch (e) { return { ok: false, error: String(e?.message || e) }; } };
  for (let r = 1; r <= rounds; r++) {
    const tag = randomUUID().slice(0, 6);
    const slug = `projtiers-${tag}`;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: 'Pine', systemPrompt: "You are Pine, a coding assistant for this project. Reply in the user's language." }) });
    const p = join(workspace, `shop-${r}-${tag}`);
    mkdirSync(p, { recursive: true });
    execFileSync('git', ['init', '-q', p]); // 项目记忆按 git 根认:工作区要是落在别的仓里,没有这个就会认到外层仓
    writeFileSync(join(p, 'README.md'), '# shop\n');
    const mkS = async (title) => (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title, model_id: MODEL, project_path: p, agent_config: { agentSlug: slug, execMode: 'host', cwd: p } }) })).session.id;
    const sid0 = await mkS(`Project tiers seed ${r}`);
    const root = realpathSync(p);
    const dir = join(home, 'project-memory', memoryDirName(root));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PROJECT.json'), JSON.stringify({ project: root }));
    writeFileSync(join(dir, 'MEMORY.md'), SEED);
    const before = (await api(`/agent/project-context?sessionId=${encodeURIComponent(sid0)}`)).memory ?? null;
    const seeded = (before?.entries?.length ?? 0) === FACTS.length;
    // 整理:2b 才有这条路由;旧引擎 404 → 跳过(负对照就是这样跑的)
    const o = seeded ? await tryApi('/agent/project-context/memory/organize', { method: 'POST', body: JSON.stringify({ sessionId: sid0 }) }) : { ok: false, error: 'not seeded' };
    const after = (await api(`/agent/project-context?sessionId=${encodeURIComponent(sid0)}`)).memory ?? null;
    const organize = { available: o.ok, status: o.ok ? o.body?.status ?? null : null, afterChars: after?.chars, limit: after?.limit ?? 4000, detail: o.ok ? o.body : o.error };
    const where = (fact) => after?.entries?.some((e) => String(e.content).includes(fact.slice(0, 20))) ? 'resident'
      : (after?.topics ?? []).find((t) => t.entries.some((e) => String(e.text).includes(fact.slice(0, 20))))?.key
      ?? ((after?.archive?.entries ?? []).some((e) => String(e.text).includes(fact.slice(0, 20))) ? 'archive' : 'gone');
    const placed = { convention: where(CONVENTION), decision: where(DECISION) };
    const agentCfg = { agentSlug: slug, cwd: p, debugSystemPrompt: true };
    let error = seeded ? null : `seed not visible to the engine (${before?.entries?.length ?? 'no memory'} of ${FACTS.length} entries)`;
    const replies = {}; const fed = {};
    if (!error) for (const [key, msg] of Object.entries(ASK)) {
      const ev = await run(await mkS(`Project tiers ${key} ${r}`), msg, 180_000, agentCfg);
      replies[key] = String(ev.content || '');
      const mark = key === 'convention' ? 'db/migrations' : 'RabbitMQ';
      fed[key] = { inSystemPrompt: !!ev.systemPrompt?.includes(mark), inRecalled: !!ev.recalled?.includes(mark), projectBlock: !!ev.systemPrompt?.includes('## Project Memory') };
      tools.push(`${key}${r}:${ev.toolCalls.join('/') || '-'}`);
      if (ev.error) { error = `${key}: ${ev.error}`; break; }
    }
    const x = grade({ seeded, conventionReply: replies.convention || '', decisionReply: replies.decision || '', organize, error });
    if (x.ok) passed++;
    const line = `${Object.entries(x.gates).map(([k, v]) => `${v ? '✓' : '✗'}${k}`).join(' ')};整理=${organize.available ? organize.status : '无入口'}`
      + `${organize.available ? `(常驻 ${before?.chars ?? '?'} → ${organize.afterChars ?? '?'} 字;约定在 ${placed.convention}、来龙去脉在 ${placed.decision})` : ''}${error ? `;出错 ${error}` : ''}`;
    console.log(`  第 ${r}/${rounds} 轮(${slug}):${x.ok ? '✓' : '✗'} ${line}`);
    outs.push(`【第 ${r} 轮${x.ok ? ' ✓' : ' ✗'}】${line}\n— 问迁移文件 —\n${replies.convention || ''}\n— 问为什么换掉 RabbitMQ —\n${replies.decision || ''}\n— 整理后的常驻 —\n${(after?.entries ?? []).map((e) => e.content).join('\n')}\n— 详情 —\n${(after?.topics ?? []).map((t) => `${t.title}(${t.key}):${t.about}\n${t.entries.map((e) => `  ${e.text}`).join('\n')}`).join('\n')}`);
    evidence.push({ round: r, slug, project: root, ok: x.ok, gates: x.gates, error, organize, placed, fed, replies, before, after });
    writeFileSync(join(OUT, 'projtiers-evidence.json'), JSON.stringify({ model: MODEL, seed: SEED, ask: ASK, rounds: evidence }, null, 2));
  }
  return { ok: passed === rounds, detail: `${passed}/${rounds} 轮全过`, output: outs.join('\n\n'), toolCalls: tools };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 种子:超过 4000;两条要问的在最老的那头(今天超线时留最新的 4000 字,它们在线外);问句的关键词只对得上那两条
  const newest = (() => { let used = 0; let i = FACTS.length; while (i > 0 && used + FACTS[i - 1].length + 1 <= 4001) { used += FACTS[i - 1].length + 1; i--; } return i; })();
  assert.ok(SEED.length > 4600, `seed must be well past the 4000 line (${SEED.length})`);
  assert.ok(newest >= 2, 'the two asked facts must fall outside the newest 4000 characters');
  for (const f of FACTS.slice(2)) assert.ok(!/迁移|RabbitMQ|数据库/.test(f), `only the two asked facts may share the questions' words: ${f}`);
  assert.equal(memoryDirName('/private/var/folders/x/shop-1'), `private-var-folders-x-shop-1-${createHash('sha256').update('/private/var/folders/x/shop-1').digest('hex').slice(0, 8)}`);
  const none = { available: false };
  assert.equal(grade({ seeded: true, conventionReply: '放在 db/migrations/ 下。', decisionReply: 'ARM 上内存太高。', organize: none }).ok, true);
  assert.equal(grade({ seeded: true, conventionReply: '不知道。', decisionReply: 'ARM 上内存太高。', organize: none }).ok, false);
  assert.equal(grade({ seeded: false, conventionReply: 'db/migrations', decisionReply: '内存', organize: none }).ok, false);
  assert.equal(grade({ seeded: true, conventionReply: 'db/migrations', decisionReply: '内存', organize: { available: true, status: 'organized', afterChars: 4100, limit: 4000 } }).ok, false);
  assert.equal(grade({ seeded: true, conventionReply: 'db/migrations', decisionReply: '内存', organize: { available: true, status: 'organized', afterChars: 2600, limit: 4000 } }).ok, true);
  console.log(`projtiers-live self-check ok (seed ${SEED.length} chars; newest 4000 start at fact ${newest + 1})`);
}
