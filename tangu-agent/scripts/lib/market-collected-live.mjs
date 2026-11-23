/** marketplace / marketplacechat(11-23 商店收录 skills.sh 技能):在 TANGU_LIVE_CLOUD_URL(server scripts/marketplace-fixture.ts)
 *  前面挡一层,其余请求原样转给它。只在列表带 `?include=collected` 时追加一条收录条目(形状照服务端契约 §3.3 / §3.4),
 *  所以没带这个参数的旧引擎搜不到它 —— 「技能」那条腿在旧代码上会红,是现成的负对照。
 *  服务端那边以后自己能出收录条目时,这里看到列表里已有 `src_25aae625_*` 就不再追加。 */
import { createServer, request } from 'node:http';

export const COLLECTED_ID = 'src_25aae625_trailmap';
/** 公开排行榜上的真实条目(lanternworks/skills,MIT);简介是 SKILL.md 的 description,README 是台架自己写的一段。 */
const COLLECTED = {
  id: COLLECTED_ID, type: 'skill', source: 'github', name: 'trailmap', author: 'lanternworks',
  summary: 'Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.',
  tags: [], installSlug: 'src-25aae625-trailmap', latestVersion: '2026.10.29-148210', downloads: 840000, platforms: ['macos', 'windows', 'linux'],
  origin: { kind: 'collected', sourceId: '25aae625', sourceTitle: 'skills.sh' },
  requirements: { cli: false, apiKeys: [], desktopOnly: false, scripts: 0, auditWarn: true },
};
const DETAIL = {
  ...COLLECTED,
  description: COLLECTED.summary,
  readme: '# trailmap\n\nCharts a large, foggy effort as a map of decision tickets on the issue tracker (GitHub Issues via gh), then works the tickets one at a time until the route to the destination is clear. Plans; does not build.',
};

export async function startCollectedMarketFront(upstream) {
  const seen = { lists: 0, listsWithCollected: 0, details: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://front');
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.method === 'GET' && url.pathname === `/api/market/items/${COLLECTED_ID}`) { seen.details++; return send(200, DETAIL); }
    const list = req.method === 'GET' && url.pathname === '/api/market/items';
    const withCollected = list && url.searchParams.get('include') === 'collected';
    if (list) { seen.lists++; if (withCollected) seen.listsWithCollected++; }
    const headers = { ...req.headers, host: new URL(upstream).host };
    if (withCollected) delete headers['accept-encoding']; // 要改写的那份按明文取
    const up = request(upstream + req.url, { method: req.method, headers }, (r) => {
      if (!withCollected || r.statusCode !== 200) { res.writeHead(r.statusCode || 502, r.headers); return r.pipe(res); }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => (body += d));
      r.on('end', () => {
        try {
          const data = JSON.parse(body);
          const items = Array.isArray(data.items) ? data.items : [];
          if (!items.some((i) => String(i?.id || '').startsWith('src_25aae625_'))) items.push(COLLECTED);
          send(200, { ...data, items });
        } catch { res.writeHead(502); res.end('bad upstream json'); }
      });
    });
    up.on('error', (e) => send(502, { detail: `market upstream: ${e.message}` }));
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
