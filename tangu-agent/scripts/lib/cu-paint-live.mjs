// Unmodified upstream JS Paint; only the input bitmap and the screenshot grader are ours.
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  lstatSync,
  renameSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, sep, join, extname } from 'node:path';
import { PNG } from 'pngjs';

const W = 510,
  H = 210,
  R = 33;
const anchor = [19, 147, 139];
const shapes = ['triangle', 'circle', 'square'];
const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
function inside(shape, x, y, radius) {
  if (shape === 'circle') return x * x + y * y < radius * radius;
  if (shape === 'square') return Math.abs(x) <= radius && Math.abs(y) <= radius;
  return Math.abs(y) <= radius && Math.abs(x) <= (y + radius) / 2;
}
function inputBitmap() {
  const png = new PNG({ width: W, height: H });
  png.data.fill(255);
  const slots = [85, 255, 425];
  const centers = shapes.map((shape) => ({
    shape,
    x: slots.splice(randomInt(slots.length), 1)[0] + randomInt(-12, 13),
    y: randomInt(76, 136),
  }));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const border = centers.some(
        (c) => inside(c.shape, x - c.x, y - c.y, R) && !inside(c.shape, x - c.x, y - c.y, R - 4),
      );
      const marker = (x < 5 && y < 5) || (x >= W - 5 && y >= H - 5);
      if (border || marker) png.data.set(marker ? anchor : [0, 0, 0], 4 * (y * W + x));
    }
  return { png, centers };
}
export function gradePaint(shot, input, outline) {
  let minX = shot.width,
    minY = shot.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < shot.height; y++)
    for (let x = 0; x < shot.width; x++) {
      const i = 4 * (y * shot.width + x);
      if (!anchor.every((v, k) => shot.data[i + k] === v)) continue;
      minX = Math.min(x, minX);
      minY = Math.min(y, minY);
      maxX = Math.max(x, maxX);
      maxY = Math.max(y, maxY);
    }
  const sx = (maxX - minX + 1) / W,
    sy = (maxY - minY + 1) / H;
  if (sx < 0.5 || Math.abs(sx - sy) > 0.03)
    return { ok: false, reason: 'Source painting is not fully visible in the screenshot' };
  const c = input.centers.find((item) => item.shape === (outline ? 'circle' : 'triangle'));
  let interior = 0,
    filled = 0,
    other = 0,
    mismatch = 0;
  const blue = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const target = 4 * ((minY + Math.floor((y + 0.5) * sy)) * shot.width + minX + Math.floor((x + 0.5) * sx));
      const src = 4 * (y * W + x);
      const [r, g, b] = shot.data.subarray(target, target + 3);
      const old = [...input.png.data.subarray(src, src + 3)];
      if (outline && r === 0 && g === 0 && b === 255 && old.every((v) => v === 255)) {
        blue.push([x, y]);
        continue;
      }
      if (!outline && inside('triangle', x - c.x, y - c.y, R - 4)) {
        interior++;
        if (r === 255 && g === 0 && b === 0) filled++;
        continue;
      }
      other++;
      if ([r, g, b].some((v, k) => v !== old[k])) mismatch++;
    }
  if (!outline)
    return {
      ok: filled === interior && mismatch === 0,
      triangleRed: filled / interior,
      unrelatedChanged: mismatch / other,
    };
  if (!blue.length) return { ok: false, reason: 'No blue outline on canvas' };
  let x1 = W,
    x2 = -1,
    y1 = H,
    y2 = -1;
  for (const [x, y] of blue) {
    x1 = Math.min(x1, x);
    x2 = Math.max(x2, x);
    y1 = Math.min(y1, y);
    y2 = Math.max(y2, y);
  }
  const sides = [new Set(), new Set(), new Set(), new Set()];
  let stray = 0;
  for (const [x, y] of blue) {
    if (x - x1 < 3) sides[0].add(y);
    if (x2 - x < 3) sides[1].add(y);
    if (y - y1 < 3) sides[2].add(x);
    if (y2 - y < 3) sides[3].add(x);
    if (Math.min(x - x1, x2 - x, y - y1, y2 - y) > 2) stray++;
  }
  const margins = [c.x - R - x1, x2 - c.x - R, c.y - R - y1, y2 - c.y - R];
  const coverage = sides.map((s, i) => s.size / (i < 2 ? y2 - y1 + 1 : x2 - x1 + 1));
  return {
    ok:
      margins.every((v) => v >= 3 && v <= 30) && coverage.every((v) => v > 0.96) && stray === 0 && mismatch === 0,
    margins,
    coverage,
    strayBlue: stray / blue.length,
    unrelatedChanged: mismatch / other,
  };
}

export function paintGradeSelftest() {
  const input = inputBitmap();
  const c = input.centers.find((item) => item.shape === 'circle');
  const draw = (color, damage = false) => {
    const shot = PNG.sync.read(PNG.sync.write(input.png));
    const d = R + 6;
    for (let y = -d; y <= d; y++) {
      for (let x = -d; x <= d; x++) {
        if (Math.abs(x) === d || Math.abs(y) === d) shot.data.set(color, 4 * ((c.y + y) * W + c.x + x));
      }
    }
    if (damage) shot.data.set(color, 4 * (c.y * W + c.x + R - 1));
    return gradePaint(shot, input, true).ok;
  };
  return [
    ['JS Paint exact blue rectangle', draw([0, 0, 255]), true],
    ['JS Paint wrong swatch', draw([10, 20, 240]), false],
    ['JS Paint damaged circle border', draw([0, 0, 255], true), false],
    ['JS Paint missing fill', gradePaint(input.png, input, false).ok, false],
  ];
}

// Only approve the test URL or an action on the last screenshot delivered in this run.
export function pixelApproval(out, key, url) {
  return request => {
    const args = JSON.parse(request.arguments || '{}');
    if (request.name === 'launch_browser' && url && args.url === url && args.mode === 'pixels' && !args.visible) return 'approve';
    const receipt = join(out,key+'-receipt.json');
    if (request.name === 'act_ui' && existsSync(receipt) &&
        args.stateId === JSON.parse(readFileSync(receipt,'utf8')).state) return 'approve';
    return 'reject';
  };
}

export function instrumentPixelFixture(shared) {
  const dist = join(shared, 'plugins/tangu-computer-use/tangu-plugins/computer-use/dist');
  renameSync(join(dist, 'index.js'), join(dist, 'provider.mjs'));
  copyFileSync(new URL('./cu-pixel-tools.mjs', import.meta.url), join(dist, 'index.js'));
}

export async function cuPaintLive({ api, run, OUT, checkout, outline, tokensOf, ttft }) {
  if (!checkout || !existsSync(join(checkout, 'index.html')))
    throw Error('Pass --cu-paint pointing to an unmodified JS Paint checkout');
  const dir = realpathSync(resolve(checkout));
  const version = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw Error('JS Paint checkout is modified');
  const plugin = (await api('/agent/plugins')).plugins?.find((p) => /computer-use/.test(p.id));
  await api('/agent/plugins/' + plugin.id + '/enabled', {
    method: 'PUT',
    body: JSON.stringify({ enabled: true }),
  });
  const tracked = new Set(execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0'));
  const input = inputBitmap(),
    source = PNG.sync.write(input.png),
    id = outline ? 'cupaintoutline' : 'cupaintfill';
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (pathname === '/sample.png') {
      res.setHeader('content-type', 'image/png');
      res.end(source);
      return;
    }
    const file = resolve(dir, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (
      !file.startsWith(dir + sep) ||
      !tracked.has(file.slice(dir.length + 1)) ||
      pathname.split('/').some((part) => part.startsWith('.')) ||
      !lstatSync(file).isFile() ||
      realpathSync(file) !== file
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    createReadStream(file)
      .on('error', () => {
        res.writeHead(404);
        res.end();
      })
      .pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const task = outline
      ? '用纯蓝色（RGB 0,0,255）的空心矩形把圆单独框起来，线框和圆四周稍微留一点空隙。'
      : '用纯红色（RGB 255,0,0）把三角形内部填满。';
    const prompt =
      '用 Computer Use 的后台纯截图模式打开 ' +
      origin +
      '/#load:' +
      origin +
      '/sample.png 。这是 JS Paint 的一份新画稿。' +
      task +
      ' 保持其他图形原样。结束时整张画稿要在屏幕上可见，核对颜色和其他图形，再告诉我结果。只根据截图操作。';
    const sessionId = 'live-' + id + '-' + Date.now();
    writeFileSync(
      join(OUT, 'pixel-target.json'),
      JSON.stringify({ key: id, sessionId, url: origin + '/#load:' + origin + '/sample.png' }),
    );
    const ev = await run(
      sessionId,
      prompt,
      180_000,
      {
        toolsMode: 'allow',
        toolsList: ['launch_browser', 'observe_ui', 'act_ui', 'use_skill', 'load_tools'],
      },
      undefined,
      pixelApproval(OUT,id,origin + '/#load:' + origin + '/sample.png'),
    );
    if (!existsSync(join(OUT,id+'-delivered.png'))) throw Error('No screenshot was delivered. '+ev.toolResults.map(t=>String(t.result||t.full||'').slice(0,140)).join(' '));
    const image = readFileSync(join(OUT, id + '-delivered.png'));
    const receipt = JSON.parse(readFileSync(join(OUT, id + '-receipt.json'), 'utf8'));
    writeFileSync(join(OUT, id + '-result.png'), image);
    writeFileSync(join(OUT, id + '-input.png'), source);
    const metrics = gradePaint(PNG.sync.read(image), input, outline);
    const allowed = new Set(['use_skill', 'load_tools', 'launch_browser', 'act_ui', 'observe_ui']);
    const calls = ev.toolArgs.map((t) => ({
      name: t.name,
      args: typeof t.arguments === 'string' ? JSON.parse(t.arguments || '{}') : t.arguments,
    }));
    const launches = calls.filter((t) => t.name === 'launch_browser');
    const actual = calls.filter((t) => t.name === 'act_ui');
    const pixelsOnly =
      receipt.count >= 2 &&
      receipt.actions > 0 &&
      launches.length > 0 &&
      launches.every((t) => t.args.mode === 'pixels') &&
      calls.every((t) => allowed.has(t.name)) &&
      actual.length > 0 &&
      actual.every(
        (t) =>
          !t.args.expect &&
          t.args.actions.every(
            (a) => !a.ref && ['click', 'drag', 'moveMouse', 'scroll', 'keypress'].includes(a.action),
          ),
      );
    writeFileSync(
      join(OUT, id + '-evidence.json'),
      JSON.stringify(
        {
          version,
          centers: input.centers,
          calls,
          metrics,
          pixelsOnly,
          receipt,
          toolResults: ev.toolResults.map((t) => ({
            name: t.name,
            error: t.isError,
            text: (t.full || t.result || '').slice(0, 550),
          })),
          reply: ev.content,
        },
        null,
        2,
      ),
    );
    return {
      ok: Boolean(ev.done && !ev.error && pixelsOnly && metrics.ok),
      detail: '纯截图链路 ' + pixelsOnly + '，画稿像素 ' + JSON.stringify(metrics),
      output: ev.content,
      toolCalls: ev.toolCalls,
      ttftMs: ttft(ev),
      tokens: tokensOf(ev),
    };
  } finally {
    server.close();
  }
}
