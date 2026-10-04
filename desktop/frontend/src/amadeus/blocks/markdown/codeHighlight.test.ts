import { describe, expect, it } from 'vitest'
import { highlightCode } from './codeHighlight'

describe('code language recognition', () => {
  it.each([
    ['javascript', 'const answer = 42;'],
    ['typescript', 'interface User {\n  name: string;\n  age: number;\n}\nconst user: User = { name: "Ada", age: 30 };'],
    ['typescript', 'const answer: number = 42;'],
    ['python', 'def greet(name):\n    print(f"Hello, {name}")\n\ngreet("Forsion")'],
    ['json', '{"name": "Forsion", "enabled": true, "count": 42}'],
    ['sql', 'SELECT name, COUNT(*) AS total\nFROM users\nWHERE active = true\nGROUP BY name;'],
    ['html', '<div class="card">\n  <h1>Hello</h1>\n</div>'],
    ['css', '.card {\n  color: red;\n  padding: 16px;\n}'],
    ['bash', '#!/bin/bash\nfor file in *.md; do\n  echo "$file"\ndone'],
    ['yaml', 'name: Forsion\nversion: 2.12.1\nfeatures:\n  - editor\n  - chat'],
    ['java', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello");\n  }\n}'],
    ['go', 'package main\nimport "fmt"\nfunc main() {\n  fmt.Println("Hello")\n}'],
    ['rust', 'fn main() {\n    let message = "Hello";\n    println!("{}", message);\n}'],
    ['c', '#include <stdio.h>\nint main(void) {\n    printf("Hello\\n");\n    return 0;\n}'],
    ['cpp', '#include <iostream>\nint main() {\n  std::cout << "Hello" << std::endl;\n  return 0;\n}'],
    ['swift', 'import Foundation\nlet names: [String] = ["Ada", "Grace"]\nfor name in names {\n    print(name)\n}'],
  ])('recognizes %s without a fence label', (language, code) => {
    const result = highlightCode(code, '')
    expect(result.language).toBe(language)
    expect(result.ranges.length).toBeGreaterThan(0)
    for (const token of result.ranges) {
      expect(token.from).toBeGreaterThanOrEqual(0)
      expect(token.to).toBeGreaterThan(token.from)
      expect(token.to).toBeLessThanOrEqual(code.length)
    }
  })

  it.each(['', 'hello world', '今天我们讨论编辑器的功能和改进。', 'This is a plain text note about our plans for tomorrow.', 'x = 1'])('does not guess from ambiguous text %j', (code) => {
    expect(highlightCode(code, '')).toEqual({ language: '', ranges: [] })
  })
  it.each(['plaintext', 'text', 'txt'])('respects explicitly selected %s', (language) => {
    expect(highlightCode('const answer = 42;', language)).toEqual({ language: '', ranges: [] })
  })
  it('explicit languages and aliases override recognition', () => {
    expect(highlightCode('const answer = 42;', 'python').language).toBe('python')
    expect(highlightCode('const answer = 42;', 'js').language).toBe('js')
  })
  it('JSON values containing other language markers remain JSON', () => {
    const code = JSON.stringify({ source: 'std::cout << "Hello";', enabled: true })
    expect(highlightCode(code, '').language).toBe('json')
  })
  it('unknown and special fence labels never become automatic', () => {
    expect(highlightCode('{"label": "Run", "action": "test"}', 'forsion-button').ranges).toEqual([])
    expect(highlightCode('const answer = 42;', 'custom-language').language).toBe('')
  })
  it('keeps Unicode offsets and highlights beyond the bounded detection sample', () => {
    const code = 'const title = "扶桑 🌳";\n' + '// padding\n'.repeat(500) + 'const tail = true;'
    const result = highlightCode(code, '')
    expect(result.language).toBe('javascript')
    expect(result.ranges.some((t) => t.from > 4096 && code.slice(t.from, t.to) === 'true')).toBe(true)
    expect(result.ranges.some((t) => code.slice(t.from, t.to) === '"扶桑 🌳"')).toBe(true)
  })
})
