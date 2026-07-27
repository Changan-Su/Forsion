import { describe, it, expect } from 'vitest'
import { normalizeAddress, shortTitle } from './browserView'
import { fileUrlOf } from './index'

describe('内置浏览器地址栏', () => {
  it('有 scheme 的原样用', () => {
    expect(normalizeAddress('https://forsion.net/a?b=1')).toBe('https://forsion.net/a?b=1')
    expect(normalizeAddress('file:///tmp/x.html')).toBe('file:///tmp/x.html')
    expect(normalizeAddress('about:blank')).toBe('about:blank')
  })

  it('像主机名的补协议;本机服务走 http(别逼 localhost 上 TLS)', () => {
    expect(normalizeAddress('forsion.net')).toBe('https://forsion.net')
    expect(normalizeAddress('localhost:3001/api')).toBe('http://localhost:3001/api')
    expect(normalizeAddress('127.0.0.1:5273')).toBe('http://127.0.0.1:5273')
  })

  it('其余当搜索词(带空格 / 无点)', () => {
    expect(normalizeAddress('electron webview 安全')).toContain('/search?q=')
    expect(normalizeAddress('电子书')).toContain('/search?q=')
    expect(normalizeAddress('  ')).toBe('')
  })
})

describe('shortTitle(真标题到达前的 tab 兜底名)', () => {
  it('网页取主机名、file 取文件名、解析不了原样回', () => {
    expect(shortTitle('https://forsion.net/a/b?c=1')).toBe('forsion.net')
    expect(shortTitle('file:///tmp/my%20report.html')).toBe('my report.html')
    expect(shortTitle('about:blank')).toBe('about:blank')
    expect(shortTitle('不是 URL')).toBe('不是 URL')
  })
})

describe('fileUrlOf', () => {
  it('POSIX 绝对路径 → file:///', () => {
    expect(fileUrlOf('/Users/a/b.html')).toBe('file:///Users/a/b.html')
  })
  it('空格 / # / ? 逐段转义(否则 # 之后被当 fragment 丢掉)', () => {
    expect(fileUrlOf('/tmp/my report#1.html')).toBe('file:///tmp/my%20report%231.html')
    expect(fileUrlOf('/tmp/a?b.html')).toBe('file:///tmp/a%3Fb.html')
  })
  it('Windows 盘符段不编码,反斜杠归一', () => {
    expect(fileUrlOf('C:\\Users\\a\\b.html')).toBe('file:///C:/Users/a/b.html')
  })
  it('UNC 的主机名进 authority(不是多两道斜杠的普通路径段)', () => {
    expect(fileUrlOf('\\\\server\\share\\index.html')).toBe('file://server/share/index.html')
    expect(fileUrlOf('//nas/公共/a b.html')).toBe('file://nas/' + encodeURIComponent('公共') + '/a%20b.html')
  })
})
