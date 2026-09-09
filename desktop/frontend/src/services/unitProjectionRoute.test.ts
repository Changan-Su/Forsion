import { describe, expect, it } from 'vitest'
import { unitProjectionRoute } from '../../../../web/src/unitProjectionRoute'

describe('Unit projection share and invitation routes', () => {
  const base = new URL('https://unit.test/web/')
  it.each(['share', 'invite'] as const)('recognizes %s inside the configured projection prefix', (kind) => {
    expect(unitProjectionRoute(new URL(`https://unit.test/web/${kind}/token%20one/?ui=mobile`), base)).toEqual({ kind, token: 'token one' })
  })
  it.each(['https://unit.test/web-other/share/token', 'https://other.test/web/share/token', 'https://unit.test/web/share/a/b', 'https://unit.test/share/token'])('ignores routes outside this projection: %s', (url) => {
    expect(unitProjectionRoute(new URL(url), base)).toBeNull()
  })
})
