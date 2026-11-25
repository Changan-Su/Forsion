// A fresh instance of the real macOS Preview opens only the run's generated image.
// The grader measures the colored figures in the screenshots actually sent to the model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
const exec = promisify(execFile);
const swift = `import AppKit
let url = URL(fileURLWithPath:CommandLine.arguments[1])
let config = NSWorkspace.OpenConfiguration()
config.activates = false
config.createsNewApplicationInstance = true
config.addsToRecentItems = false
config.arguments = ["-ApplePersistenceIgnoreState","YES"]
let existing = Set(NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.Preview").map{$0.processIdentifier})
NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath:"/System/Applications/Preview.app"), configuration:config) { app, err in
  guard let app, !existing.contains(app.processIdentifier), app.bundleIdentifier == "com.apple.Preview" else { exit(1) }
  print(app.processIdentifier)
  exit(0)
}
RunLoop.main.run()`;
function randomPicture() {
  const png = new PNG({ width: 480, height: 240 });
  png.data.fill(255);
  const shapes = ['圆形', '三角形', '正方形'];
  for (let i = 2; i > 0; i--) {
    const j = randomInt(i + 1);
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  }
  const colors = [
    [225, 35, 45],
    [30, 90, 220],
    [35, 165, 60],
  ];
  for (let i = 0; i < 3; i++) {
    const cy = 100 + randomInt(35);
    for (let y = -32; y <= 32; y++)
      for (let x = -32; x <= 32; x++) {
        if (
          (shapes[i] === '圆形' && x * x + y * y > 32 * 32) ||
          (shapes[i] === '三角形' && Math.abs(x) > (y + 32) / 2)
        )
          continue;
        png.data.set(colors[i], 4 * ((cy + y) * png.width + 80 + 160 * i + x));
      }
  }
  return { shapes, bytes: PNG.sync.write(png) };
}
async function pictureMetrics(jpeg, png) {
  await exec('/usr/bin/sips', ['-s', 'format', 'png', jpeg, '--out', png]);
  const shot = PNG.sync.read(readFileSync(png));
  const marks = Array.from({ length: 3 }, () => ({ x: 0, y: 0, count: 0 }));
  for (let i = 0; i < shot.data.length; i += 4) {
    const r = shot.data[i],
      g = shot.data[i + 1],
      b = shot.data[i + 2];
    let mark;
    if (r > 165 && g < 85 && b < 95) mark = marks[0];
    else if (r < 80 && g < 130 && b > 160) mark = marks[1];
    else if (r < 95 && g > 125 && b < 110) mark = marks[2];
    if (mark) {
      mark.count++;
      mark.x += (i / 4) % shot.width;
      mark.y += Math.floor(i / 4 / shot.width);
    }
  }
  const centers = marks.map(({ x, y, count }) => ({ x: x / count, y: y / count, count }));
  let documentTop;
  for (let y = 0; y < shot.height; y++) {
    let whites = 0,
      total = 0;
    for (let x = Math.floor(0.32 * shot.width); x < 0.68 * shot.width; x += 3) {
      const i = 4 * (y * shot.width + x);
      total++;
      if (Math.min(...shot.data.subarray(i, i + 3)) > 244) whites++;
    }
    if (whites / total > 0.95) {
      documentTop = y;
      break;
    }
  }
  return { red: marks[0].count, documentTop, centers };
}

const gestures = {
  cupreview: '用鼠标点一次工具栏的放大按钮。',
  cupreviewmarkup: '根据当前截图把标记工具栏切换一次（用鼠标点击，在显示和隐藏间切换）。',
  cupreviewrotate: '记下目前图形从左到右的顺序，再用鼠标点击工具栏，把这张图片向左旋转九十度。',
};

function turnedLeft(before, after) {
  if ([...before, ...after].some((p) => p.count < 300)) return false;
  const [red, blue, green] = after;
  const spread = Math.max(...after.map((p) => p.x)) - Math.min(...after.map((p) => p.x));
  return (
    before[0].x + 30 < before[1].x &&
    before[1].x + 30 < before[2].x &&
    green.y + 30 < blue.y &&
    blue.y + 30 < red.y &&
    spread < (red.y - green.y) * 0.3
  );
}

export async function cuPreviewLive({ api, run, OUT, ttft, tokensOf, key }) {
  if (process.platform !== 'darwin') throw Error('This scenario needs macOS Preview');
  const plugin = (await api('/agent/plugins')).plugins.find((p) => /computer-use/.test(p.id));
  await api('/agent/plugins/' + plugin.id + '/enabled', {
    method: 'PUT',
    body: JSON.stringify({ enabled: true }),
  });
  const sessionId = 'live-cupreview-' + Date.now();
  const pic = randomPicture(),
    path = join(OUT, 'Vision-' + Date.now() + '.png');
  writeFileSync(path, pic.bytes);
  const script = join(OUT, 'launch-preview.swift');
  writeFileSync(script, swift);
  const sample = async () => {
    const { stdout } = await exec('/usr/bin/lsappinfo', ['front']);
    return (await exec('/usr/bin/lsappinfo', ['info', '-only', 'pid', stdout.trim()])).stdout.match(
      /pid"?\s*=\s*(\d+)/,
    )?.[1];
  };
  let sampling = true,
    pid;
  const samples = [];
  const monitor = (async () => {
    while (sampling) {
      const value = await sample().catch(() => undefined);
      if (value) samples.push(Number(value));
      await delay(90);
    }
  })();
  try {
    pid = Number((await exec('/usr/bin/swift', [script, path], { timeout: 40000 })).stdout.trim());
    if (!Number.isSafeInteger(pid) || pid < 2) throw Error('No fresh Preview process');
    await delay(1100);
    writeFileSync(join(OUT, 'pixel-target.json'), JSON.stringify({ key, sessionId, pid }));
    const ev = await run(
      sessionId,
      `只看截图操作 macOS 预览 PID ${pid} 的 Vision 图片窗口。${gestures[key]}保持后台。请用 find_roots 按 PID 找窗口，用 observe_ui 的 pixels 模式看图。点击后再用一次同样的 observe_ui 核对最终画面，告诉我操作前三种图形从左到右的顺序。如果没能验证就直说，不重复点击。`,
      160_000,
      { toolsMode: 'allow', toolsList: ['find_roots', 'observe_ui', 'act_ui', 'use_skill', 'load_tools'] },
      undefined, () => 'reject',
    );
    const before = await pictureMetrics(join(OUT, key + '-first.jpg'), join(OUT, key + '-before.png'));
    const after = await pictureMetrics(join(OUT, key + '-delivered.jpg'), join(OUT, key + '-result.png'));
    const shapeWords = {
      圆形: /圆形|圆|circle/i,
      三角形: /三角形|三角|triangle/i,
      正方形: /正方形|方形|方块|square/i,
    };
    const positions = pic.shapes.map((s) => ev.content.search(shapeWords[s]));
    const readOrder = positions[0] >= 0 && positions[0] < positions[1] && positions[1] < positions[2];
    const calls = ev.toolArgs.map((t) => ({ name: t.name, args: JSON.parse(t.arguments || '{}') }));
    const actions = calls.filter((c) => c.name === 'act_ui').flatMap((c) => c.args.actions);
    const receipt = JSON.parse(readFileSync(join(OUT, key + '-receipt.json'), 'utf8'));
    const toolbarShift = Math.abs(after.documentTop - before.documentTop);
    const zoom = after.red / before.red,
      front = samples.filter((n) => n === pid).length;
    const rotated = turnedLeft(before.centers, after.centers);
    const actionVerified = {
      cupreview: zoom > 1.18,
      cupreviewmarkup: toolbarShift >= 25 && toolbarShift <= 120 && Math.abs(zoom - 1) < 0.15,
      cupreviewrotate: rotated,
    }[key];
    const ok = Boolean(
      ev.done &&
        !ev.error &&
        readOrder &&
        before.red > 300 &&
        receipt.count >= 2 &&
        receipt.actions === 1 &&
        actionVerified &&
        actions.length === 1 &&
        samples.length > 10 &&
        front === 0,
    );
    writeFileSync(
      join(OUT, key + '-evidence.json'),
      JSON.stringify(
        {
          shapes: pic.shapes,
          readOrder,
          before,
          after,
          zoom,
          actionVerified,
          rotated,
          calls,
          receipt,
          outputs: ev.toolResults.map((t) => ({
            name: t.name,
            error: t.isError,
            text: String(t.full || t.result || '').slice(0, 1400),
          })),
          front,
          samples: samples.length,
          reply: ev.content,
        },
        null,
        2,
      ),
    );
    return {
      ok,
      detail: `动作核验 ${actionVerified}，图形顺序 ${readOrder}，红色面积比 ${zoom.toFixed(2)}，画稿顶边 ${before.documentTop}→${after.documentTop}，点击 ${actions.length} 次，前台 ${front}/${samples.length}`,
      output: ev.content,
      ttftMs: ttft(ev),
      tokens: tokensOf(ev),
      toolCalls: ev.toolCalls,
    };
  } finally {
    sampling = false;
    await monitor;
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
}
