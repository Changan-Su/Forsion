import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import type { Root } from 'mdast'

// One grammar for block splitting and rendering. Keep transformations (wiki links,
// heading IDs, soft breaks) outside this cache: they mutate trees and depend on context.
const parser = unified().use(remarkParse).use(remarkMath).use(remarkGfm)
  .use(remarkCjkFriendly).use(remarkCjkFriendlyStrikethrough)
const cache = new Map<string, Root>()
let chars = 0
const MAX_CHARS = 256 * 1024
const MAX_ENTRIES = 512

export function parseMarkdown(source: string): Root {
  const hit = cache.get(source)
  if (hit) {
    cache.delete(source); cache.set(source, hit)
    return structuredClone(hit)
  }
  const tree = parser.parse(source) as Root
  if (source.length <= MAX_CHARS) {
    while (cache.size && (chars + source.length > MAX_CHARS || cache.size >= MAX_ENTRIES)) {
      const oldest = cache.keys().next().value!
      chars -= oldest.length; cache.delete(oldest)
    }
    cache.set(source, structuredClone(tree)); chars += source.length
  }
  return tree
}

/** react-markdown still owns transforms, URL safety and React element creation. */
export function remarkCachedParse(this: Processor): void {
  this.parser = (source) => parseMarkdown(source)
}
