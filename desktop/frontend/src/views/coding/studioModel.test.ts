import { describe, expect, it } from 'vitest'
import { collectStudioWrites, inflightStudioWrite, joinProjectPath, normalizeDevUrl, normPath, projectRelative } from './studioModel'
import type { ToolEvent, UiMessage } from '../../types'

const tool = (name: string, args: unknown, patch: Partial<ToolEvent> = {}): ToolEvent => ({ id: name, name, arguments: typeof args === 'string' ? args : JSON.stringify(args), done: true, ...patch })
const message = (...events: ToolEvent[]): UiMessage => ({ id: 'm', role: 'assistant', content: '', status: 'done', timestamp: 1, toolEvents: events })

describe('Coding Studio project paths', () => {
  it('accepts relative tool targets and paths inside the project on POSIX and Windows', () => {
    expect(projectRelative('/work/app/', '/work/app/src/main.ts')).toBe('src/main.ts')
    expect(projectRelative('/work/app', 'src/main.ts')).toBe('src/main.ts')
    expect(projectRelative('/work/app', './src/main.ts')).toBe('src/main.ts')
    expect(projectRelative('C:\\work\\app', 'C:\\work\\app\\index.html')).toBe('index.html')
    expect(projectRelative('C:\\work\\app', 'src\\main.ts')).toBe('src/main.ts')
  })
  it('rejects traversal, adjacent project names, absolute outside paths, and missing filenames', () => {
    for (const path of ['../secret', 'src/../../secret', '/work/app/../secret', '/work/app-other/index.html', '/etc/passwd', '.', '', '/work/app', 'src/\0file', 'C:\\outside\\file']) {
      expect(projectRelative('/work/app', path), path).toBeNull()
    }
    expect(projectRelative('relative/root', 'file.ts')).toBeNull()
    expect(projectRelative('/work/../app', 'file.ts')).toBeNull()
  })
  it('keeps filesystem roots valid and never produces double separators when joining', () => {
    expect(normPath('/')).toBe('/')
    expect(normPath('C:\\')).toBe('C:/')
    expect(joinProjectPath('/', 'index.html')).toBe('/index.html')
    expect(projectRelative('/', '/index.html')).toBe('index.html')
  })
})

describe('Coding Studio agent write detection', () => {
  it('collects successful relative and absolute write tools, deduplicating files and filtering outsiders', () => {
    const messages = [message(tool('write_file', { path: './index.html' }), tool('edit_file', { file_path: '/work/app/src/main.ts' }), tool('multi_edit', { path: 'src/main.ts' }), tool('write_file', { path: '../secret' }), tool('read_file', { path: 'ignored.ts' }), tool('write_file', { path: 'failed.ts' }, { isError: true }), tool('write_file', { path: 'partial.ts' }, { done: false }))]
    expect(collectStudioWrites(messages, '/work/app')).toEqual(['index.html', 'src/main.ts'])
  })
  it('understands apply_patch Add/Update/Delete and actual Move to lines, including input payloads', () => {
    const patch = '*** Begin Patch\n*** Add File: index.html\n+hello\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** Delete File: stale.ts\n*** End Patch'
    expect(collectStudioWrites([message(tool('apply_patch', { patch }))], '/work/app')).toEqual(['index.html', 'src/old.ts', 'src/new.ts', 'stale.ts'])
    expect(collectStudioWrites([message(tool('apply_patch', { input: patch.replace(/\n/g, '\r\n') }))], '/work/app')).toEqual(['index.html', 'src/old.ts', 'src/new.ts', 'stale.ts'])
  })
  it('survives null, primitive and incomplete argument payloads, retaining the tool artifact path', () => {
    for (const args of ['null', '0', '[]', '{']) {
      expect(collectStudioWrites([message(tool('write_file', args, { artifactPath: '/work/app/index.html' }))], '/work/app')).toEqual(['index.html'])
    }
  })
  it('only follows an unfinished write from the latest assistant turn', () => {
    const old = message(tool('write_file', { path: 'old.ts' }, { done: false }))
    const newest = message(tool('write_file', { path: 'new.ts' }, { done: false }))
    expect(inflightStudioWrite([old, newest])).toEqual(newest.toolEvents![0])
    expect(inflightStudioWrite([old, message(tool('read_file', { path: 'new.ts' }, { done: false }))])).toBeNull()
    expect(inflightStudioWrite([message(tool('write_file', { path: 'done.ts' }))])).toBeNull()
  })
})

describe('Coding Studio dev URL validation', () => {
  it('normalizes loopback HTTP/HTTPS URLs while preserving app paths and queries', () => {
    expect(normalizeDevUrl('  localhost:5173/app?q=1  ')).toBe('http://localhost:5173/app?q=1')
    expect(normalizeDevUrl('https://127.0.0.1:3000')).toBe('https://127.0.0.1:3000/')
    expect(normalizeDevUrl('http://[::1]:8080')).toBe('http://[::1]:8080/')
    expect(normalizeDevUrl('  ')).toBe('')
  })
  it('rejects remote origins, credentials, misleading hostnames, malformed ports, and non-web protocols', () => {
    for (const input of ['https://example.com', 'https://localhost.example.com', 'http://127.0.0.1.evil.test', 'http://localhost@evil.test', 'http://user:secret@localhost:3000', 'file:///tmp/a.html', 'javascript:alert(1)', 'ftp://localhost/a', 'localhost:99999', 'http://192.168.1.1']) {
      expect(normalizeDevUrl(input), input).toBeNull()
    }
  })
})
