import { expect, it } from 'vitest'
import { forsionAccountNamespace } from './forsionAccountNamespace.js'

const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

it('uses the host SHA-256 namespace for normalized and UTF-8 account IDs', () => {
  expect(forsionAccountNamespace('https://CLOUD.Test:443/api//', jwt({ userId: 'u-1' }))).toBe('269683363ad79e90ddb2ae616c6a07879848503a2b9f23c41bfdf6ea4b41412b')
  expect(forsionAccountNamespace('https://a.test', jwt({ sub: '用户一' }))).toBe('408c444fd1a069714ab308cc3bc06329e97635e88fdab9dcf53ee3d8d6d59bd4')
  expect(forsionAccountNamespace('https://a.test', 'broken')).toBeNull()
})
