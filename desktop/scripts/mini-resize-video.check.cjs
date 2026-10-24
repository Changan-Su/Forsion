/** Inspect a compositor recording of ONLY the isolated dark Mini fixture.
 * ffmpeg must be on PATH. Reports square corners missed by DOM screenshots.
 * node scripts/mini-resize-video.check.cjs <video> [--expect-rounded]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs'), assert = require('node:assert/strict')
const file = process.argv[2]
assert.ok(file && fs.existsSync(file), 'Supply a compositor recording of the isolated Mini fixture')
const size = 360, bytes = size * size * 3
const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=360:360,fps=30', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
let pending = Buffer.alloc(0), frames = 0, detected = 0; const square = []
child.stdout.on('data', data => {
  pending = Buffer.concat([pending, data])
  while (pending.length >= bytes) {
    const b = pending.subarray(0, bytes); pending = pending.subarray(bytes)
    const bright = (x, y) => { const i = (y * size + x) * 3; return b[i] > 200 && b[i + 1] > 200 && b[i + 2] > 200 }
    let left = size, top = size, right = -1, bottom = -1
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (bright(x, y)) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
    if (right - left > 80 && bottom - top > 50) {
      detected++
      // A stale rectangular Chromium surface reaches the bounding-box corner.
      const corners = [[left, top], [right, top], [left, bottom], [right, bottom]].map(([x, y]) => bright(x, y))
      if (corners.some(Boolean)) square.push({ frame: frames, seconds: frames / 30, corners, bounds: { left, top, right, bottom } })
    }
    frames++
  }
})
child.on('close', code => {
  assert.equal(code, 0); assert.ok(detected > 100, 'Recording must contain the light card on the dark fixture')
  const result = { frames, detected, squareFrames: square.length, square }
  fs.writeFileSync(file + '.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ frames, detected, squareFrames: square.length, first: square.slice(0, 3) }))
  if (process.argv.includes('--expect-rounded') && square.length) process.exitCode = 1
})
