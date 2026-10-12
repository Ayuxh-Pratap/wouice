const { app } = require('electron')
const pty = require('node-pty')
const fs = require('node:fs')
const path = require('node:path')
const resultPath = path.resolve(__dirname, '../projects-pty-result.json')
app.setPath('userData', path.resolve(__dirname, '../.projects-probe'))
app.whenReady().then(() => {
  const terminal = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { cwd: path.resolve(__dirname, '..'), cols: 80, rows: 24, env: process.env })
  let output = '', phase = 0
  const timeout = setTimeout(() => finish(false, 'Timed out'), 20000)
  function finish(ok, reason) {
    clearTimeout(timeout)
    try { terminal.kill() } catch {}
    fs.writeFileSync(resultPath, JSON.stringify({ ok, reason, electron: process.versions.electron, node: process.versions.node, nodePty: require('node-pty/package.json').version, output }, null, 2))
    app.exit(ok ? 0 : 1)
  }
  terminal.onData(data => {
    output += data
    if (phase === 0 && output.includes('PTY_READY')) {
      phase = 1; terminal.resize(112, 32)
      terminal.write("Start-Sleep -Seconds 30\r")
      setTimeout(() => { terminal.write('\x03'); setTimeout(() => terminal.write("Write-Output ('RESIZE_' + 'OK'); Write-Output ([char]0x0939); exit\r"), 600) }, 1400)
    }
  })
  terminal.onExit(({ exitCode }) => finish(exitCode === 0 && output.includes('RESIZE_OK') && output.includes('ह'), 'Spawn, input/output, resize, Ctrl+C and Unicode'))
  terminal.write("Write-Output ('PTY_' + 'READY')\r")
}).catch(error => { fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error) })); app.exit(1) })
