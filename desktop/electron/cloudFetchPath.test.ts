/**
 * `cloud:fetch` 的路径解析闸。这是主进程给请求盖用户 forsion_token 之前的**唯一**边界 ——
 * 放松任何一条,它就从「以你的身份调你自己的服务端」变成「拿你的云端 token 打任意主机」。
 * 所以这里的重点全是**拒绝**用例,放行只留一条。
 */
import { describe, it, expect } from 'vitest'
import { resolveCloudApiUrl } from './cloudApiPath'

const CLOUD = 'https://api.forsion.net'

describe('resolveCloudApiUrl', () => {
  it('正路:相对路径拼到 /api 之下', () => {
    expect(resolveCloudApiUrl(CLOUD, '/meeting/rooms')).toBe('https://api.forsion.net/api/meeting/rooms')
    expect(resolveCloudApiUrl(CLOUD, '/meeting/rooms/ABC/sig')).toBe('https://api.forsion.net/api/meeting/rooms/ABC/sig')
    expect(resolveCloudApiUrl(CLOUD, '/x?a=1&b=2')).toBe('https://api.forsion.net/api/x?a=1&b=2')
  })

  it('cloudUrl 已含 /api(web/mobile 垫片形态)不重复拼', () => {
    expect(resolveCloudApiUrl('https://api.forsion.net/api', '/meeting/rooms')).toBe('https://api.forsion.net/api/meeting/rooms')
  })

  it('尾部斜杠不影响', () => {
    expect(resolveCloudApiUrl('https://api.forsion.net///', '/x')).toBe('https://api.forsion.net/api/x')
  })

  // 实测:因为总是用 `origin + '/api' + path` **锚定**,path 里的 `//` 变不成协议相对 URL,
  // 只会成为自家服务器上的一个怪路径 —— 无害。这里断言的是「它确实还在自家 origin 上」,
  // 而不是「它被拒了」;写成后者就是给一个不存在的保护发绿灯。
  it('协议相对形状的 path 仍落在自家 origin(不构成外泄)', () => {
    expect(resolveCloudApiUrl(CLOUD, '//evil.com/steal')).toBe('https://api.forsion.net/api//evil.com/steal')
    expect(resolveCloudApiUrl(CLOUD, '/\\\\evil.com/x')?.startsWith('https://api.forsion.net/')).toBe(true)
  })

  it('⚠️ 路径穿越逃出 /api 必须拒', () => {
    expect(resolveCloudApiUrl(CLOUD, '/../units')).toBeNull()
    expect(resolveCloudApiUrl(CLOUD, '/a/../../units')).toBeNull()
    expect(resolveCloudApiUrl(CLOUD, '/%2e%2e/units')).toBeNull()
  })

  it('⚠️ 绝对 URL / 非相对路径必须拒', () => {
    expect(resolveCloudApiUrl(CLOUD, 'https://evil.com/x')).toBeNull()
    expect(resolveCloudApiUrl(CLOUD, 'meeting/rooms')).toBeNull()
    expect(resolveCloudApiUrl(CLOUD, '')).toBeNull()
    expect(resolveCloudApiUrl(CLOUD, null)).toBeNull()
    expect(resolveCloudApiUrl(CLOUD, 42)).toBeNull()
  })

  it('⚠️ 非 http(s) 的 cloudUrl 必须拒(file:/data: 之类)', () => {
    expect(resolveCloudApiUrl('file:///tmp', '/x')).toBeNull()
    expect(resolveCloudApiUrl('', '/x')).toBeNull()
    expect(resolveCloudApiUrl(undefined, '/x')).toBeNull()
  })

  it('自建/内网地址照常放行(只约束 origin 一致,不约束是谁)', () => {
    expect(resolveCloudApiUrl('http://192.168.1.9:3001', '/meeting/rooms')).toBe('http://192.168.1.9:3001/api/meeting/rooms')
  })
})
