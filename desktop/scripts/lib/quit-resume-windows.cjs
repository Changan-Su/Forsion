// Windows has no ps -E. Observe the fixture's managed engine launch fields and
// shutdown intent before the parent sends a shutdown request or kills it.
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const dir = process.env.FORSION_QUIT_RESUME_OBSERVATIONS
const spawn = childProcess.spawn
process.argv = process.argv.filter((arg, index, args) => arg !== __filename && !((arg === '-r' || arg === '--require') && args[index + 1] === __filename))

childProcess.spawn = function (file, args, options) {
  const child = spawn.apply(this, arguments)
  const dataIndex = Array.isArray(args) ? args.indexOf('--data-dir') : -1
  const envHome = options?.env?.TANGU_HOME
  if (!child.pid || dataIndex < 0 || envHome !== path.join(process.env.TANGU_HOME, 'tangu')) return child
  const dataDir = args[dataIndex + 1]
  const envAuto = options.env.TANGU_AUTO_RESUME ?? null
  fs.writeFileSync(path.join(dir, `engine-${child.pid}.json`), JSON.stringify({ dataDir, envHome, envAuto }))
  const observe = (method) => {
    const observation = path.join(dir, `before-shutdown-${child.pid}.json`)
    if (fs.existsSync(observation)) return
    const intentFile = path.join(envHome, 'shutdown-intent.json')
    const intent = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile, 'utf8')) : null
    fs.writeFileSync(observation, JSON.stringify({ method, intent }))
  }
  const write = child.stdin.write
  child.stdin.write = function (line) {
    if (typeof line === 'string' && JSON.parse(line).shutdown === true) observe('stdin')
    return write.apply(this, arguments)
  }
  const kill = child.kill
  child.kill = function (signal) {
    observe(signal)
    return kill.call(this, signal)
  }
  return child
}
