import rehypeKatex from 'rehype-katex'
import type { Element, Root, RootContent } from 'hast'
import type { VFile } from 'vfile'

const render = rehypeKatex()
const cache = new Map<string, { children: RootContent[]; nodes: number }>()
let nodes = 0
const MAX_NODES = 20000
const MAX_ENTRIES = 128
const count = (node: RootContent): number => 1 + ('children' in node ? node.children.reduce((n, child) => n + count(child), 0) : 0)

/** Cache only formula output, never a document's headings, links, React elements or
 * context. KaTeX remains the renderer, with its original defaults/security policy.
 * Clones isolate later transforms (MathBox) and invalid formulas retain diagnostics. */
export function rehypeCachedKatex() {
  return (tree: Root, file: VFile): void => {
    const walk = (parent: Root | Element, ancestors: Array<Root | Element>): void => {
      for (let i = 0; i < parent.children.length; i++) {
        const scope = parent.children[i]
        if (scope.type !== 'element') continue
        const code = scope.tagName === 'pre' && scope.children.length === 1 && scope.children[0].type === 'element'
          ? scope.children[0] : scope
        const classes = code.properties.className
        const math = Array.isArray(classes) && classes.some((c) => ['language-math', 'math-inline', 'math-display'].includes(String(c)))
        if (!math) { walk(scope, [...ancestors, scope]); continue }
        // The fixed remark grammar produces plain text code nodes for all math forms.
        // Unusual nodes still use the original transformer, without a cache entry.
        const key = code.tagName === 'code' && code.children.every((c) => c.type === 'text')
          ? JSON.stringify([scope.tagName, code.properties, code.children.map((c) => c.type === 'text' ? c.value : '').join('')]) : ''
        const hit = key && cache.get(key)
        let children: RootContent[]
        if (hit) {
          cache.delete(key); cache.set(key, hit)
          children = structuredClone(hit.children)
        } else {
          const fragment: Root = { type: 'root', children: [scope] }
          const messages = file.messages.length
          render(fragment, file)
          for (const message of file.messages.slice(messages)) {
            if (message.ancestors?.[0] === fragment) message.ancestors = [...ancestors, ...message.ancestors.slice(1)]
          }
          children = fragment.children
          const size = children.reduce((n, child) => n + count(child), 0)
          if (key && key.length <= 8192 && size <= MAX_NODES && file.messages.length === messages) {
            while (cache.size && (nodes + size > MAX_NODES || cache.size >= MAX_ENTRIES)) {
              const oldest = cache.keys().next().value!
              nodes -= cache.get(oldest)!.nodes; cache.delete(oldest)
            }
            cache.set(key, { children: structuredClone(children), nodes: size }); nodes += size
          }
        }
        ;(parent.children as RootContent[]).splice(i, 1, ...children)
        i += children.length - 1
      }
    }
    walk(tree, [tree])
  }
}
