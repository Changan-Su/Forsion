const path = require('node:path')
const {spawnSync} = require('node:child_process')
const root = require('./lib/obsidian-bridge-root.cjs')()
const tasks = {build:'build',check:'check:baseline',expanded:'check:expanded'}
const task = tasks[process.argv[2]]
if (!task) throw Error('Expected build, check or expanded')
const env = {...process.env,FORSION_DESKTOP:path.resolve(__dirname,'..')}
const run = script => spawnSync(process.platform === 'win32'?'npm.cmd':'npm',['run',script],{cwd:root,env,stdio:'inherit',shell:process.platform === 'win32'})
let result = run(task)
if (result.error) throw result.error
if (result.status === 0 && process.argv[2] === 'expanded') result = run('check:host')
if (result.error) throw result.error
process.exitCode = result.status ?? 1
