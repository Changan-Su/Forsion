// Run through e2e-editor.cjs --script=performance-baseline.check.cjs.
// Real unified editor + synthetic, fixed corpus; no model or external network timing.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const option = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const output = path.resolve(option('out', path.join(__dirname, '../outputs/performance/baseline.json')));
const baselinePath = option('baseline', '');
const injectMs = Number(option('inject-block-ms', '0'));
const samples = Number(option('samples', '30'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const distribution = values => {
  const sorted = [...values].sort((a,b)=>a-b), mean = values.reduce((a,b)=>a+b,0)/values.length;
  const stddev = Math.sqrt(values.reduce((n,v)=>n+(v-mean)**2,0)/values.length);
  return { samples:values, n:values.length, p50:sorted[Math.floor(sorted.length*.5)], p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))], mean, stddev, coefficientOfVariation:mean ? stddev/mean : 0 };
};
function corpus(size) {
  return Array.from({ length:size }, (_,i)=>[`Note-${i}.md`, `# Note ${i}\n\nFixed seed 271279. 中文笔记 ${i}.\n\n${'Deterministic local editor workload. '.repeat(12)}\n\n- [ ] task\n\n[link](https://example.invalid/)\n`]);
}
async function main() {
  const sourceInfo = require('./performance-source.cjs');
  sourceInfo.assertOutput(output);
  if (baselinePath) sourceInfo.assertOutput(baselinePath);
  const executablePath = process.env.CHROMIUM_EXE;
  if (!executablePath) throw new Error('Set CHROMIUM_EXE to a fixed installed Chromium executable');
  const browser = await chromium.launch({ executablePath, headless:true });
  const report = { schemaVersion:1, source:require('./performance-source.cjs')(), commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    diffSha256:hash(execFileSync('git',['diff','--binary','HEAD'],{cwd:root,maxBuffer:50*1024*1024})),
    instrumentSha256:hash(fs.readFileSync(__filename)),
    environment:{ platform:process.platform, release:os.release(), arch:process.arch, cpu:os.cpus()[0].model,
      logicalCpus:os.cpus().length, totalMemory:os.totalmem(), node:process.version, browser:browser.version(), viewport:[1200,900] },
    warmup:{ inputSamples:5, lifecycleWarmup:10, forcedGc:'CDP HeapProfiler.collectGarbage before each heap sample' },
    scope:'Chromium unified-editor harness with in-memory note corpus and two pages. Not Electron application startup, disk vault indexing, or operating-system RSS.',
    excluded:{ modelNetwork:'No real model calls; local input/paint and lifecycle only', electronMainRss:'not measured', fullApplicationStartup:'not measured' },
    injectionMs:injectMs, scenarios:[] };
  try {
    for (const size of [1000,10000]) {
      const notes=corpus(size), datasetSha256=hash(JSON.stringify(notes));
      const pages=[], startup=[];
      for(let windowIndex=0;windowIndex<2;windowIndex++) {
        const p=await browser.newPage({locale:'en-US',viewport:{width:1200,height:900}});
        const started=performance.now();
        await p.goto(`${process.env.HARNESS_URL || 'http://localhost:5173/harness.html'}?upage&useed=%23%20seed`,{waitUntil:'domcontentloaded',timeout:120000});
        await p.waitForSelector('.unified-body .ProseMirror',{timeout:120000});
        startup.push(performance.now()-started);
        await p.evaluate(notes=>{ for(const [name,text] of notes) window.__upage.vault.set(name,text); },notes);
        pages.push(p);
      }
      const p=pages[0], cdp=await p.context().newCDPSession(p);
      await cdp.send('HeapProfiler.enable');
      const heap=[];
      const sampleHeap=async cycle=>{ await cdp.send('HeapProfiler.collectGarbage'); const m=await cdp.send('Runtime.getHeapUsage'); heap.push({cycle,...m}); };
      const change=async i=>{
        await p.evaluate(i=>window.__upage.switchFile(`Note-${i}.md`),i);
        await p.waitForFunction(i=>window.__upage.probe.view()?.state.doc.textContent.startsWith(`Note ${i}`),i,{timeout:10000});
      };
      for(let i=0;i<10;i++) await change(i);
      await sampleHeap(0);
      await p.evaluate(()=>{
        window.__perfLongTasks=[];
        new PerformanceObserver(list=>window.__perfLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});
      });
      const input=[];
      for(let i=0;i<samples+5;i++) {
        const ms=await p.evaluate(async injectMs=>{
          const v=window.__upage.probe.view(), start=performance.now();
          v.dispatch(v.state.tr.insertText('x',1));
          while(performance.now()-start<injectMs) { /* controlled negative test only */ }
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          return performance.now()-start;
        },injectMs);
        if(i>=5) input.push(ms);
      }
      const switches=[];
      for(let i=1;i<=100;i++) { const start=performance.now(); await change(10+i); switches.push(performance.now()-start); if(i%10===0) await sampleHeap(i); }
      const longTasks=await p.evaluate(()=>window.__perfLongTasks);
      const heapStart=heap[0].usedSize, heapEnd=heap.at(-1).usedSize;
      const mid=heap.filter(h=>h.cycle>=50), mx=mid.reduce((n,h)=>n+h.cycle,0)/mid.length, my=mid.reduce((n,h)=>n+h.usedSize,0)/mid.length;
      const slope=mid.reduce((n,h)=>n+(h.cycle-mx)*(h.usedSize-my),0)/mid.reduce((n,h)=>n+(h.cycle-mx)**2,0);
      const scenario={ name:`editor-${size}-notes-two-pages`, datasetSha256, noteCount:size, pages:2,
        rendererNavigationMs:startup, inputToTwoAnimationFramesMs:distribution(input), pageSwitchMs:distribution(switches),
        longTasksMs:longTasks, memory:{ process:'renderer V8 heap',samples:heap,retainedDeltaBytes:heapEnd-heapStart,last50CyclesBytesPerCycle:slope} };
      // Diagnostic trigger, not a calibrated product budget. Keep a heap on suspicious retention.
      if(heapEnd>heapStart*1.5+8*1024*1024) {
        const heapPath=`${output}.${size}.heapsnapshot`, chunks=[];
        cdp.on('HeapProfiler.addHeapSnapshotChunk',event=>chunks.push(event.chunk));
        await cdp.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false});
        fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(heapPath,chunks.join(''));scenario.memory.heapSnapshot=heapPath;
      }
      report.scenarios.push(scenario);
      for(const page of pages) await page.close();
    }
    report.endSource = sourceInfo();
    if (report.endSource.sourceSha256 !== report.source.sourceSha256) {
      report.invalidated = 'Source changed during measurement (possible HMR); discard comparison';
      fs.mkdirSync(path.dirname(output), { recursive:true }); fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
      throw new Error(report.invalidated);
    }
    if(baselinePath) {
      const previous=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
      if(previous.source?.sourceSha256!==report.source.sourceSha256) throw new Error('Baseline source mismatch');
      if(JSON.stringify(previous.warmup)!==JSON.stringify(report.warmup)) throw new Error('Baseline warmup mismatch');
      if(JSON.stringify(previous.environment)!==JSON.stringify(report.environment)) throw new Error('Baseline environment mismatch');
      const threshold=Number(option('regression-ratio','0.15'));
      report.comparison={ baseline:baselinePath, provisionalThreshold:threshold, measurements:[], regressions:[] };
      for(const scenario of report.scenarios) {
        const before=previous.scenarios.find(s=>s.name===scenario.name&&s.datasetSha256===scenario.datasetSha256);
        if(!before) throw new Error(`Baseline dataset mismatch: ${scenario.name}`);
        const ratio=scenario.inputToTwoAnimationFramesMs.p95/before.inputToTwoAnimationFramesMs.p95-1;
        report.comparison.measurements.push({scenario:scenario.name,beforeP95:before.inputToTwoAnimationFramesMs.p95,afterP95:scenario.inputToTwoAnimationFramesMs.p95,relativeChange:ratio});
        if(ratio>threshold) report.comparison.regressions.push({scenario:scenario.name,metric:'inputToTwoAnimationFramesMs.p95',ratio});
      }
    }
    fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
    console.log(`Performance report: ${output}`);
    if(report.comparison?.regressions.length) { console.error(report.comparison.regressions); process.exitCode=1; }
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
