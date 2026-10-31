/** Dedicated-runner observations only; never capture a personal desktop. */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

function capture(output, label, target) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Startup diagnostics require a dedicated CI runner')
  fs.mkdirSync(output, { recursive: true })
  const base = path.join(output, label)
  const run = (command, args, suffix) => {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, windowsHide: true })
    fs.writeFileSync(`${base}-${suffix}.txt`, `${r.stdout || ''}\n${r.stderr || ''}\n${r.error || ''}`)
    return r.stdout || ''
  }
  if (process.platform === 'darwin') {
    run('screencapture', ['-x', `${base}.png`], 'screen')
    run('ps', ['-axo', 'pid,ppid,stat,etime,comm'], 'processes')
    const rows = run('ps', ['-axo', 'pid=,comm='], 'commands')
    const real = file => { try { return fs.realpathSync(file) } catch { return file } }
    for (const line of rows.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/)
      if (match && real(match[2]) === real(target)) run('sample', [match[1], '1', '1', '-file', `${base}-sample.txt`], 'sample-command')
    }
  } else if (process.platform === 'win32') {
    const quote = value => `'${value.replace(/'/g, "''")}'`
    const script = `
      Get-Process | Where-Object { $_.MainWindowTitle -or $_.ProcessName -match 'forsion|setup|installer' } |
        Select-Object Id,ProcessName,MainWindowTitle,Responding,Path | ConvertTo-Json -Depth 3
      try {
        Add-Type -AssemblyName System.Windows.Forms,System.Drawing
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bounds.Size); $bitmap.Save(${quote(base + '.png')},[System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $graphics.Dispose(); $bitmap.Dispose() }
      } catch { Write-Output $_ }
      try {
        Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational';StartTime=(Get-Date).AddMinutes(-10)} -MaxEvents 30 -ErrorAction Stop |
          Select-Object TimeCreated,Id,Message | ConvertTo-Json -Depth 3
      } catch { Write-Output $_ }
    `
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 'windows')
  }
}

function watch(output, label, target) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Startup diagnostics require a dedicated CI runner')
  const child = spawn(process.execPath, [__filename, output, label, target], { stdio: 'ignore', windowsHide: true })
  child.unref()
  return () => child.kill()
}
module.exports = { capture, watch }
if (require.main === module) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Startup diagnostics require a dedicated CI runner')
  const [output, label, target] = process.argv.slice(2)
  for (const seconds of [45, 180]) setTimeout(() => capture(output, `${label}-${seconds}s`, target), seconds * 1000)
}
