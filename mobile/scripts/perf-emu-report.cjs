#!/usr/bin/env node
/** Read a first-open trace or sampling profile saved by perf-emu.cjs. */
const fs = require('node:fs')
const path = require('node:path')
const { SourceMap } = require('node:module')

const [kind, dir, mapDir] = process.argv.slice(2)
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
const ms = (us) => (us / 1000).toFixed(1)

function intervalTime(events, start, end) {
  const intervals = events.map((e) => [Math.max(start, e.ts), Math.min(end, e.ts + e.dur)])
    .filter(([a, b]) => b > a)
    .sort(([a], [b]) => a - b)
  let total = 0
  let covered = start
  for (const [a, b] of intervals) {
    total += Math.max(0, b - Math.max(a, covered))
    covered = Math.max(covered, b)
  }
  return total
}

function summarizeTrace() {
  const { pid, tid, thread, t0, loadBefore, load } = read('results.json').results.find((r) => r.name === 'trace open-cold')
  const trace = read('trace-open-cold.json')
  const onMain = (e) => e.pid === pid && e.tid === tid
  const main = trace.filter((e) => onMain(e) && e.ph === 'X' && e.dur > 0)
  const tasks = main.filter((e) => e.name === 'RunTask')
  const layouts = main.filter((e) => e.name === 'Layout')
  const styles = main.filter((e) => e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles')
  const scripts = main.filter((e) => /^(FunctionCall|EvaluateScript|RunMicrotasks|[vV]8[.][Ee]xecute)$/.test(e.name))
  if (!tasks.length || !layouts.length || !styles.length || !scripts.length) throw new Error('Incomplete renderer trace')
  console.log(`渲染线程 ${pid}/${tid} ${thread} · 负载 ${loadBefore.toFixed(2)} → ${load.toFixed(2)}`)
  const show = (label, start, end) => {
    const busy = intervalTime(tasks, start, end)
    const layout = intervalTime(layouts, start, end)
    const layoutStyle = intervalTime([...layouts, ...styles], start, end)
    const classified = intervalTime([...layouts, ...styles, ...scripts], start, end)
    console.log(`${label} · 主线程 ${ms(busy)} ms · 脚本 ${ms(classified - layoutStyle)} ms · 样式 ${ms(layoutStyle - layout)} ms · 布局 ${ms(layout)} ms · 其余 ${ms(busy - classified)} ms`)
  }
  show('点按后 700 ms', t0, t0 + 700000)
  show('点按后 2000 ms', t0, t0 + 2000000)
  const marks = trace.filter((e) => onMain(e) && e.ts >= t0 && /^probe-(detail|transcript|slide-(start|end))$/.test(e.name))
  for (const mark of marks) console.log(`${mark.name} +${ms(mark.ts - t0)} ms`)
  const slideStart = marks.find((e) => e.name === 'probe-slide-start')
  const slideEnd = marks.find((e) => e.name === 'probe-slide-end')
  if (slideStart && slideEnd) show('主区 transform 过渡回调之间', slideStart.ts, slideEnd.ts)
  console.log('点按后 2000 ms 内最长的主线程任务')
  const longest = tasks.filter((e) => e.ts + e.dur > t0 && e.ts < t0 + 2000000)
    .sort((a, b) => b.dur - a.dur).slice(0, 10)
  for (const task of longest) show(`+${ms(task.ts - t0)} ms`, task.ts, task.ts + task.dur)
}

function summarizeProfile() {
  const profile = read('profile-open-cold.cpuprofile')
  const { rate, loadBefore, load } = read('results.json').results.find((r) => r.name === 'profile first open')
  if (!profile.samples?.length) throw new Error('Empty sampling profile')
  const symbols = new Map()
  const parents = new Map()
  const maps = new Map()
  for (const { id, children, callFrame } of profile.nodes) {
    const { functionName, url, lineNumber, columnNumber } = callFrame
    const file = path.basename(url.split('?')[0])
    let original
    if (mapDir && file.endsWith('.js')) {
      if (!maps.has(file)) {
        const filePath = path.join(mapDir, `${file}.map`)
        maps.set(file, fs.existsSync(filePath) ? new SourceMap(JSON.parse(fs.readFileSync(filePath, 'utf8'))) : null)
      }
      original = maps.get(file)?.findEntry(lineNumber, columnNumber)
    }
    const source = original?.originalSource?.replace(/^(\.\.\/)+/, '').replace(/^.*\/node_modules\//, 'node_modules/')
    const location = source ? `${source}:${original.originalLine + 1}:${original.originalColumn + 1}` : file ? `${file}:${lineNumber + 1}:${columnNumber + 1}` : ''
    symbols.set(id, { label: `${original?.name || functionName || '(anonymous)'} ${location}`.trim(), source })
    for (const child of children || []) parents.set(child, id)
  }
  const self = new Map()
  const inclusive = new Map()
  const bySource = new Map()
  const add = (totals, key, delta) => totals.set(key, (totals.get(key) || 0) + delta)
  profile.samples.forEach((id, i) => {
    const delta = profile.timeDeltas[i] || 0
    add(self, symbols.get(id).label, delta)
    const seen = new Set()
    const seenSources = new Set()
    for (let current = id; current != null; current = parents.get(current)) {
      const { label, source } = symbols.get(current)
      if (!seen.has(label)) add(inclusive, label, delta)
      seen.add(label)
      if (source && !seenSources.has(source)) add(bySource, source, delta)
      seenSources.add(source)
    }
  })
  console.log(`首次打开 ${rate}x · ${profile.samples.length} 个样本 · 负载 ${loadBefore.toFixed(2)} → ${load.toFixed(2)}`)
  const rank = (label, totals) => {
    console.log(label)
    const top = [...totals].filter(([key]) => !/^\((idle|program|root)\)$/.test(key))
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
    for (const [key, us] of top) console.log(`  ${ms(us).padStart(7)} ms  ${key}`)
  }
  rank('函数自身采样耗时', self)
  rank('函数栈上采样耗时（各行可重叠）', inclusive)
  if (mapDir) rank('源码文件栈上采样耗时（各行可重叠）', bySource)
}

if (kind === 'trace' && dir) summarizeTrace()
else if (kind === 'profile' && dir) summarizeProfile()
else {
  console.error('Usage: node scripts/perf-emu-report.cjs trace|profile <OUT> [source-map directory]')
  process.exitCode = 2
}
