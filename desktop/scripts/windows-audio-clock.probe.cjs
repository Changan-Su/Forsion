/** Isolate native Windows audio-clock drift from plugin/UI behavior. No debugger focus emulation. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
async function main() {
  assert.equal(process.platform, 'win32')
  const wav = process.env.DITING_WAV
  assert.ok(wav && fs.existsSync(wav), 'DITING_WAV must identify a local PCM fixture')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-audio-clock-'))
  const source = path.join(home, 'main.cjs'), result = path.join(home, 'result.json')
  const timerModule = path.join(home, 'timer.cjs')
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../electron/windowsAudioClock.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: timerModule })
  fs.writeFileSync(path.join(home, 'page.html'), '<title>ZZ Windows audio clock</title><p>Isolated silent file microphone probe</p>')
  fs.writeFileSync(source, `
const { app, BrowserWindow, powerSaveBlocker } = require('electron');
const fs = require('node:fs'); const sleep = ms => new Promise(r => setTimeout(r,ms));
const readPolicy = win => {
 if(!process.env.AUDIO_POLICY_PROBE)return null;
 const code = \`Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class TimerQuery {
 [StructLayout(LayoutKind.Sequential)] struct State { public uint Version,Control,Value; }
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int id);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessInformation(IntPtr h,int kind,ref State state,uint size);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 public static string Read(int id){var h=OpenProcess(0x1000,false,id);try{var s=new State{Version=1};if(!GetProcessInformation(h,4,ref s,12))return id+"|error:"+Marshal.GetLastWin32Error();return id+"|"+s.Control+"|"+s.Value;}finally{CloseHandle(h);}}
}
'@
[Console]::Write([TimerQuery]::Read(\`+process.pid+\`)+";"+[TimerQuery]::Read(\`+win.webContents.getOSProcessId()+\`))\`;
 return require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
};
app.whenReady().then(async () => {
 if(process.env.AUDIO_PROTECT_EARLY)console.log('EARLY_PROTECTION '+JSON.stringify(await require(${JSON.stringify(timerModule)}).protectWindowsAudioClock()));
 const win = new BrowserWindow({x:50,y:80,width:640,height:400,show:false,webPreferences:{backgroundThrottling:true}});
 await win.loadFile(require('node:path').join(__dirname,'page.html'));
 win.showInactive();
 await win.webContents.executeJavaScript(\`(async () => {
  window.mic = await navigator.mediaDevices.getUserMedia({audio:true});
  window.ac = new AudioContext({sampleRate:16000}); await ac.resume();
  const source = ac.createMediaStreamSource(mic), proc = ac.createScriptProcessor(4096,1,1), mute=ac.createGain(); mute.gain.value=0;
  window.samples=0; window.nonzero=0; proc.onaudioprocess=e=>{samples+=e.inputBuffer.length;for(const v of e.inputBuffer.getChannelData(0))if(Math.abs(v)>.0001)nonzero++};
  source.connect(proc);proc.connect(mute);mute.connect(ac.destination);
 })()\`,true);
 if(process.env.AUDIO_PROTECT_AFTER_CAPTURE)console.log('CAPTURE_PROTECTION '+JSON.stringify(await require(${JSON.stringify(timerModule)}).protectWindowsAudioClock(process.env.AUDIO_PROTECT_RENDERER ? win.webContents.getOSProcessId() : process.pid)));
 const snapshot=()=>win.webContents.executeJavaScript('({ context:ac.currentTime,samples,nonzero,rate:ac.sampleRate,wall:Date.now(),monotonic:performance.now(),visibility:document.visibilityState,output:ac.getOutputTimestamp() })');
 const rows=[];
 for(const mode of ${JSON.stringify((process.env.AUDIO_MODES || 'visible,minimized,unthrottled-minimized,blocked-suspension-minimized,hidden,protected-timers-minimized').split(','))}) {
  if(mode==='protected-timers-minimized'){const protection=await require(${JSON.stringify(timerModule)}).protectWindowsAudioClock(win.webContents.getOSProcessId());console.log('TIMER_PROTECTION '+JSON.stringify(protection));if(!protection.changed)throw Error('Could not protect native timer requests');}
  win.webContents.setBackgroundThrottling(mode!=='unthrottled-minimized');
  if(win.isMinimized())win.restore();
  let blocker;
  if(mode==='blocked-suspension-minimized')blocker=powerSaveBlocker.start('prevent-app-suspension');
  if(mode.includes('minimized'))win.minimize();else if(mode==='hidden')win.hide();else win.showInactive();
  await sleep(1000);const powerA=readPolicy(win);const a=await snapshot();await sleep(20000);const b=await snapshot();const powerB=readPolicy(win);
  const row={mode,minimized:win.isMinimized(),visible:win.isVisible(),throttling:win.webContents.getBackgroundThrottling(),powerA,powerB,a,b};rows.push(row);console.log(JSON.stringify(row));
  if(blocker!==undefined)powerSaveBlocker.stop(blocker);
 }
 fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(rows,null,2));app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});`)
  const child = spawn(require('electron'), ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, ...(process.env.AUDIO_IN_PROCESS ? ['--disable-features=AudioServiceOutOfProcess'] : []), `--user-data-dir=${path.join(home, 'userdata')}`, source], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.equal(code, 0)
  const rows = JSON.parse(fs.readFileSync(result, 'utf8'))
  const protectedRow = rows.find(row => row.mode === 'protected-timers-minimized') || (process.env.AUDIO_PROTECT_AFTER_CAPTURE ? rows.find(row => row.mode === 'minimized') : null)
  if (protectedRow) {
  assert.ok(protectedRow.minimized && !protectedRow.visible && protectedRow.b.visibility === 'hidden', 'Positive control is actually minimized and hidden')
  assert.ok(protectedRow.b.nonzero > protectedRow.a.nonzero, 'Positive control receives real file audio rather than silent callbacks')
  assert.ok((protectedRow.b.samples - protectedRow.a.samples) / protectedRow.b.rate > (protectedRow.b.monotonic - protectedRow.a.monotonic) / 1000 * .9, 'Protected background PCM tracks elapsed monotonic time')
  }
  for (const row of rows) console.log(JSON.stringify({ mode: row.mode, wall: (row.b.wall-row.a.wall)/1000, monotonic: (row.b.monotonic-row.a.monotonic)/1000, context: row.b.context-row.a.context, pcm: (row.b.samples-row.a.samples)/row.b.rate, visibility: row.b.visibility }))
  fs.mkdirSync(path.join(__dirname, '../outputs/windows-issues'), { recursive: true })
  fs.copyFileSync(result, path.join(__dirname, '../outputs/windows-issues/audio-clock-result.json'))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
