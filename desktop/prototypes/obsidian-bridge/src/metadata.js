import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { parse, stringify } from "yaml";
const parser = unified().use(remarkParse).use(remarkFrontmatter);
const point = (p) => ({
  line: p.line - 1,
  col: p.column - 1,
  offset: p.offset,
});
const position = (n) => ({
  start: point(n.position.start),
  end: point(n.position.end),
});
const text = (n) => n.value || (n.children || []).map(text).join("");
export function metadata(source) {
  const ast = parser.parse(source);
  const cache = {
    headings: [],
    sections: [],
    listItems: [],
    links: [],
    embeds: [],
  };
  function walk(n, parentLine = -1) {
    if (n.type === "heading")
      cache.headings.push({
        heading: text(n),
        level: n.depth,
        position: position(n),
      });
    if (n.type === "listItem") {
      cache.listItems.push({
        position: position(n),
        parent: parentLine,
        task: undefined,
      });
      parentLine = n.position.start.line - 1;
    }
    if (n.type === "link")
      cache.links.push({
        link: n.url,
        displayText: text(n),
        position: position(n),
      });
    if (n.type === "yaml") {
      try {
        cache.frontmatter = parse(n.value) || {};
      } catch (error) {
        cache.frontmatterError = String(error?.message || error);
      }
      cache.frontmatterPosition = position(n);
    }
    for (const child of n.children || []) walk(child, parentLine);
  }
  walk(ast);
  for (const n of ast.children)
    cache.sections.push({ type: n.type, position: position(n) });
  return cache;
}
export function updateFrontmatter(source, mutate) {
  const cache = metadata(source);
  if (cache.frontmatterError)
    throw Error("Invalid frontmatter: " + cache.frontmatterError);
  const data = cache.frontmatter || {};
  mutate(data);
  const tail = cache.frontmatterPosition
    ? source.slice(cache.frontmatterPosition.end.offset).replace(/^\r?\n/, "")
    : source;
  return "---\n" + stringify(data) + "---\n" + tail;
}
