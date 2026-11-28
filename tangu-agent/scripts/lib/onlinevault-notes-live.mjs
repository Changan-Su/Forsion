import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { forsionAccountNamespace } from '../../dist/core/forsionAccountNamespace.js';

export function onlineVaultToken() {
  const payload = Buffer.from(JSON.stringify({ userId: 'online-vault-fixture', jti: randomUUID() })).toString('base64url');
  return `fixture.${payload}.unsigned`;
}

export async function startOnlineVaultNotes(token, out) {
  const vaultId = randomUUID();
  const prefix = 'Amadeus/';
  const fileId = randomUUID();
  const name = 'Work';
  const note = 'Entry.md';
  const marker = `note-${randomUUID().slice(0, 8)}`;
  const initial = `Work reference: ${marker}`;
  const addition = 'Reviewed today.';
  const localContents = 'This copy is local.';
  const noteRequests = [];
  let content = initial;
  let seq = 1;
  let writes = 0;
  const vaultUrl = `/api/amadeus/vaults/${vaultId}`;
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/amadeus/')) return send(404, { detail: 'Fixture route not found' });
      const caps = req.headers['x-content-caps'];
      noteRequests.push({ method: req.method, path: url.pathname, caps });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { detail: 'Fixture authorization failed' });
      if (caps !== 'vaults') return send(409, { detail: 'Expected only the vaults capability' });
      if (req.method === 'GET' && url.pathname === '/api/amadeus/libraries') {
        return send(200, { libraries: [{ kind: 'own', id: vaultId, vaultId, prefix, name }] });
      }
      if (req.method === 'GET' && url.pathname === `${vaultUrl}/tree`) return send(200, { pages: [note], files: [] });
      if (url.pathname !== `${vaultUrl}/file`) return send(404, { detail: 'Fixture route not found' });
      if (req.method === 'GET' && url.searchParams.get('path') === note) return send(200, { id: fileId, path: note, content, seq });
      if (req.method !== 'PUT') return send(404, { detail: 'file not found' });
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.path !== note || typeof body.content !== 'string') return send(400, { detail: 'Unexpected fixture write' });
      if (body.baseSeq !== seq || body.expectedFileId !== fileId) return send(409, { seq, content });
      content = body.content;
      writes++;
      return send(200, { seq: ++seq });
    } catch {
      send(400, { detail: 'Invalid fixture request' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = join(out, 'userData', 'amadeus-config.json');
  const local = join(out, 'localVault');
  mkdirSync(dirname(config), { recursive: true });
  mkdirSync(local);
  writeFileSync(join(local, note), localContents);
  const account = forsionAccountNamespace(url, token);
  writeFileSync(config, JSON.stringify({
    lastVault: local,
    activeVault: { kind: 'online', account, libraryId: vaultId, vaultId, prefix, name },
  }));
  return {
    url,
    config,
    stop: () => { server.close(); server.closeAllConnections(); },
    async run(run) {
      const ev = await run(`live-onlinevault-notes-${randomUUID()}`,
        `In my current Amadeus library, read ${note} and tell me its reference. Then update the same note by adding a separate line that says exactly "${addition}". Keep the existing text.`,
        240_000, { execMode: 'host', preset: 'work', approvalMode: 'full-auto', debugSystemPrompt: true });
      const prompt = ev.systemPrompt || '';
      const checks = {
        completed: ev.done && !ev.error,
        onlinePrompt: prompt.includes(`"${name}" (online)`) && prompt.includes('You cannot run commands') && !prompt.includes(local),
        readByTool: ev.toolCalls.includes('amadeus_read_note') && ev.content.includes(marker),
        wroteOnline: ev.toolCalls.includes('amadeus_write_note') && writes === 1 &&
          content.replace(/\r\n/g, '\n').trim().split(/\n+/).join('\n') === `${initial}\n${addition}`,
        localUnchanged: readdirSync(local).length === 1 && readFileSync(join(local, note), 'utf8') === localContents,
        scopedRequests: noteRequests.filter(r => r.path === '/api/amadeus/libraries').length === 1 &&
          noteRequests.every(r => r.caps === 'vaults' && ['/api/amadeus/libraries', `${vaultUrl}/tree`, `${vaultUrl}/file`].includes(r.path)),
        noFileOrShellTools: ev.toolCalls.every(tool => !['run_bash', 'read_file', 'write_file', 'edit_file', 'apply_patch'].includes(tool)),
      };
      return { ok: Object.values(checks).every(Boolean), detail: JSON.stringify(checks),
        toolCalls: ev.toolCalls, tokens: ev.tokens, ttftMs: ev.ttftMs, output: ev.content };
    },
  };
}
