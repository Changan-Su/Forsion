const fs = require('node:fs')
const path = require('node:path')

async function observe(url, read) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    return { status: response.status, ...(response.ok ? await read(response) : {}) }
  } catch (error) { return { error: error.name } }
}
const region = async response => {
  const { country, mainland_china } = await response.json()
  return { country, mainland_china }
}
async function main() {
  const [website, backend, reference] = await Promise.all([
    observe('https://forsion.net/api/auth/region', region),
    observe('https://api.forsion.net/api/auth/region', region),
    observe('https://www.cloudflare.com/cdn-cgi/trace', async res => ({ country: /(?:^|\n)loc=([A-Z]{2})(?:\n|$)/.exec(await res.text())?.[1] })),
  ])
  const result = { website, backend, reference, runner: process.env.RUNNER_OS }
  console.log(JSON.stringify(result))
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'forsion-update-region.json'), JSON.stringify(result, null, 2))
}
main().catch(error => { console.error(error.name); process.exit(1) })
