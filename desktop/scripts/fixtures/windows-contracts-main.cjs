const { app, BrowserWindow } = require('electron')
globalThis.__windowsProbeRequire = require
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 500, height: 300, show: false })
  win.loadURL('data:text/html,<title>Forsion Windows contract probe</title><p>Isolated verification</p>')
})
