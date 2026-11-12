import { createServer } from 'node:http';
const id = '00000000-0000-0000-0000-000000000026';
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAIfkEAQAAAAAsAAAAAAEAAQAAAgJEAQA7';
export async function startImageRecoveryCloud(token) {
  const seen = []; let acknowledged = false;
  const cloud = { beforeAck: async () => false, savedAtAck: false };
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', async () => {
      seen.push({ method: req.method, path: req.url });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, {});
      if (req.method === 'GET' && req.url === '/v1/images/jobs') return send(200, { jobs: [{ id, state: acknowledged ? 'delivered' : 'ready', receipt: 'fixture-hash', prompt: '少女头发轻动、花瓣飘落的动图', model: 'gpt-image-2.6-sunburst', createdAt: new Date().toISOString() }] });
      if (req.method === 'GET' && req.url === `/v1/images/jobs/${id}`) return send(200, { id, state: acknowledged ? 'delivered' : 'ready', receipt: 'fixture-hash', result: { data: [{ b64_json: gif }] } });
      if (req.method === 'POST' && req.url === `/v1/images/jobs/${id}/ack`) { cloud.savedAtAck = await cloud.beforeAck(); acknowledged = true; return send(200, { acknowledged }); }
      return send(404, { error: 'No generation allowed in recovery fixture' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); server.unref();
  return Object.assign(cloud, { url: `http://127.0.0.1:${server.address().port}`, seen, id, gif });
}
export async function imageRecoveryLive({ run, api, cloud }) {
  const session = `live-image-recovery-${Date.now()}`;
  cloud.beforeAck = async () => {
    const rows = (await api(`/agent/sessions/${session}/messages`)).messages || [];
    return rows.flatMap(m => m.display_files || []).some(f => f.imageDelivery?.id === cloud.id && f.dataUrl === `data:image/gif;base64,${cloud.gif}`);
  };
  const ev = await run(session, '刚才生成的少女动图超时了，帮我找回已经生成的结果并显示出来。不要重新生成，也不要画替代品。', 240_000, { preset: 'chat', execMode: 'sandbox', cwd: undefined });
  const messages = (await api(`/agent/sessions/${session}/messages`)).messages || [];
  const files = messages.flatMap(m => m.display_files || []);
  const persisted = files.some(f => f.imageDelivery?.id === cloud.id && f.dataUrl === `data:image/gif;base64,${cloud.gif}`);
  const recovered = ev.toolCalls.includes('recover_image');
  const ack = cloud.seen.some(r => r.path.endsWith('/ack'));
  const regenerated = cloud.seen.some(r => r.method === 'POST' && !r.path.endsWith('/ack')) || ev.toolCalls.some(n => ['edit_image','generate_image'].includes(n));
  return { ok: !ev.error && recovered && persisted && cloud.savedAtAck && ack && !regenerated,
    detail: ev.error || `恢复工具=${recovered};会话持久化 GIF=${persisted};确认前已落库=${cloud.savedAtAck};确认=${ack};重新生成=${regenerated}`,
    output: ev.content, toolCalls: ev.toolCalls };
}
