import { describe, expect, it } from 'vitest'
import { hostMatchesNetworkPatterns, MAX_NETWORK_PATTERNS, normalizeNetworkPattern, sanitizeNetworkPatterns } from './pluginNetwork'

describe('manifest network patterns', () => {
  it('accepts exact hosts and subdomain wildcards, normalized', () => {
    expect(normalizeNetworkPattern('API.Example.com')).toBe('api.example.com')
    expect(normalizeNetworkPattern(' api.example.com. ')).toBe('api.example.com')
    expect(normalizeNetworkPattern('*.example.com')).toBe('*.example.com')
    expect(normalizeNetworkPattern('*.cdn.example.co.uk')).toBe('*.cdn.example.co.uk')
    expect(normalizeNetworkPattern('xn--fiqs8s.example')).toBe('xn--fiqs8s.example')
  })

  it.each([
    ['https://api.example.com', 'scheme'],
    ['api.example.com:8443', 'port'],
    ['api.example.com/v1', 'path'],
    ['*', 'bare wildcard'],
    ['*.com', 'wildcard over a whole TLD'],
    ['api.*.com', 'wildcard in the middle'],
    ['*example.com', 'wildcard without a dot'],
    ['localhost', 'single label'],
    ['127.0.0.1', 'IPv4 literal'],
    ['[::1]', 'IPv6 literal'],
    ['::1', 'IPv6 literal, unbracketed'],
    ['-bad.example.com', 'leading hyphen'],
    ['bad-.example.com', 'trailing hyphen'],
    ['例子.com', 'non-ASCII'],
    ['user@example.com', 'userinfo'],
    ['', 'empty'],
  ])('rejects %s (%s)', (raw) => {
    expect(normalizeNetworkPattern(raw)).toBeNull()
  })

  it('sanitizes a manifest list: dedupes, reports the rest, caps the count', () => {
    expect(sanitizeNetworkPatterns(['api.example.com', 'API.example.com', '*.cdn.example.com', 'http://x.com', 42]))
      .toEqual({ patterns: ['api.example.com', '*.cdn.example.com'], invalid: ['http://x.com', '42'] })
    expect(sanitizeNetworkPatterns(undefined)).toEqual({ patterns: [], invalid: [] })
    expect(sanitizeNetworkPatterns('api.example.com').patterns).toEqual([])
    const many = Array.from({ length: MAX_NETWORK_PATTERNS + 3 }, (_, i) => `h${i}.example.com`)
    const r = sanitizeNetworkPatterns(many)
    expect(r.patterns).toHaveLength(MAX_NETWORK_PATTERNS)
    expect(r.invalid).toHaveLength(3)
  })

  it('matches on label boundaries; a wildcard covers subdomains but not the apex', () => {
    const p = ['api.example.com', '*.cdn.example.net']
    expect(hostMatchesNetworkPatterns('api.example.com', p)).toBe(true)
    expect(hostMatchesNetworkPatterns('API.EXAMPLE.COM.', p)).toBe(true)
    expect(hostMatchesNetworkPatterns('x.api.example.com', p)).toBe(false)
    expect(hostMatchesNetworkPatterns('example.com', p)).toBe(false)
    expect(hostMatchesNetworkPatterns('a.cdn.example.net', p)).toBe(true)
    expect(hostMatchesNetworkPatterns('a.b.cdn.example.net', p)).toBe(true)
    expect(hostMatchesNetworkPatterns('cdn.example.net', p)).toBe(false)
    expect(hostMatchesNetworkPatterns('evilcdn.example.net', p)).toBe(false)
    expect(hostMatchesNetworkPatterns('a.cdn.example.net.evil.com', p)).toBe(false)
    expect(hostMatchesNetworkPatterns('127.0.0.1', ['*.0.0.1'])).toBe(false)
    expect(hostMatchesNetworkPatterns('api.example.com', [])).toBe(false)
  })
})
