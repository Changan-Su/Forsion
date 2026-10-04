/**
 * Amadeus saves cards / columns as flat Markdown plus frontmatter ownership.
 * Keep the engine's root-block view aligned with unified/{fm,columns,canvas}.ts:
 * unregistered anchors and invalid layouts remain ordinary document content.
 */
import type { Token } from 'marked';
import { parse as parseYaml } from 'yaml';

type JsonObject = Record<string, unknown>;
interface LayoutRow { columns: Array<{ refs: string[]; width: number }>; tail?: string }
const ID = /^[A-Za-z0-9_-]+$/;
const OPEN = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->$/;
const CLOSE = /^<!--\s*\/a\s+([A-Za-z0-9_-]+)\s*-->$/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** Same entry boundaries as shared/amadeus/compiler/split.ts fmEntries. */
function entriesOf(frontmatter: string): string[][] {
  const inner = /^\uFEFF?---\r?\n([\s\S]*?)---[ \t]*(?:\r?\n|$)$/.exec(frontmatter)?.[1] ?? '';
  const out: string[][] = [];
  let current: string[] | undefined;
  let gap: string[] = [];
  const flush = () => { out.push(...gap.map((line) => [line])); gap = []; };
  for (const line of inner.replace(/\r?\n$/, '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) gap.push(line);
    else if (/^[ \t]/.test(line) || /^-(?:[ \t]|$)/.test(line) || /^[}\],]/.test(line)) {
      if (current) { current.push(...gap, line); gap = []; }
      else { flush(); out.push([line]); }
    } else {
      flush(); current = [line]; out.push(current);
    }
  }
  flush();
  return out;
}

/** Last duplicate wins; parse one entry so unrelated YAML cannot change scope. */
function structureValue(entries: string[][], key: 'layout' | 'canvas'): unknown {
  const re = new RegExp(`^["']?amadeus_${key}["']?\\s*:`);
  const entry = entries.filter((e) => re.test(e[0])).at(-1);
  if (!entry) return null;
  try {
    if (entry.length === 1) return JSON.parse(entry[0].replace(re, '').trim());
    const parsed: unknown = parseYaml(entry.join('\n'));
    const value = object(parsed) ? Object.values(parsed)[0] : null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch { return null; }
}

function layoutRows(value: unknown): LayoutRow[] {
  if (!object(value) || value.v !== 4 || !Array.isArray(value.rows)) return [];
  for (const row of value.rows) {
    if (!object(row) || !Array.isArray(row.columns) || !row.columns.length) return [];
    if (row.tail != null && !id(row.tail)) return [];
    for (const col of row.columns) {
      if (!object(col) || !Array.isArray(col.refs) || !col.refs.length || !col.refs.every(id)) return [];
      if (!number(col.width) || col.width <= 0) return [];
    }
  }
  return value.rows as LayoutRow[];
}

function canvasRefs(value: unknown): Set<string> {
  const empty = new Set<string>();
  if (!object(value) || value.v !== 1) return empty;
  if (value.mode != null && value.mode !== 'doc' && value.mode !== 'canvas') return empty;
  const geometry = (v: unknown) => object(v) && number(v.w) && v.w > 0 && number(v.x) && number(v.y)
    && (v.h == null || (number(v.h) && v.h >= 0));
  if (value.main != null && !geometry(value.main)) return empty;
  if (value.elements != null && !Array.isArray(value.elements)) return empty;
  if (value.cards == null) return empty;
  if (!Array.isArray(value.cards)) return empty;
  const refs: string[] = [];
  for (const card of value.cards) {
    if (!object(card) || !id(card.ref) || !geometry(card)) return empty;
    refs.push(card.ref);
  }
  return new Set(refs).size === refs.length ? new Set(refs) : empty;
}

function marker(token: Token, re: RegExp): string | undefined {
  const html = token.type === 'html' ? token.text
    : token.type === 'paragraph' && token.tokens?.length === 1 && token.tokens[0].type === 'html'
      ? token.tokens[0].text : null;
  return typeof html === 'string' ? re.exec(html.trim())?.[1] : undefined;
}

function openingMarkers(tokens: Token[]): Array<{ id: string; index: number }> {
  return tokens.flatMap((token, index) => {
    const ref = marker(token, OPEN);
    return ref ? [{ id: ref, index }] : [];
  });
}

/** Replace containers with inert placeholders, preserving their root boundary. */
function replaceRegions(tokens: Token[], regions: Array<{ from: number; to: number }>): void {
  for (const { from, to } of regions.sort((a, b) => b.from - a.from)) {
    tokens.splice(from, to - from, { type: 'space', raw: '' });
  }
}

function foldColumns(tokens: Token[], rows: LayoutRow[]): void {
  const markers = openingMarkers(tokens);
  const ordOf = new Map<string, number>();
  markers.forEach((m, i) => ordOf.set(m.id, ordOf.has(m.id) ? -1 : i));
  const consumed = new Set<number>();
  const regions: Array<{ from: number; to: number }> = [];
  for (const row of rows) {
    if (row.columns.length < 2) continue;
    const ords = row.columns.flatMap((c) => c.refs).map((ref) => ordOf.get(ref) ?? -1);
    if (ords.some((o) => o < 0 || consumed.has(o)) || new Set(ords).size !== ords.length) continue;
    if (!ords.every((o, i) => i === 0 || o === ords[i - 1] + 1)) continue;
    const next = ords[ords.length - 1] + 1;
    const tail = row.tail != null && markers[next]?.id === row.tail && !consumed.has(next);
    regions.push({ from: markers[ords[0]].index, to: markers[next] ? markers[next].index + (tail ? 1 : 0) : tokens.length });
    ords.forEach((o) => consumed.add(o));
    if (tail) consumed.add(next);
  }
  replaceRegions(tokens, regions);
}

function foldCanvas(tokens: Token[], refs: Set<string>, rows: LayoutRow[]): void {
  const taken = new Set(rows.flatMap((row) => [...row.columns.flatMap((c) => c.refs), ...(row.tail ? [row.tail] : [])]));
  const markers = openingMarkers(tokens);
  const counts = new Map<string, number>();
  markers.forEach((m) => counts.set(m.id, (counts.get(m.id) ?? 0) + 1));
  const regions: Array<{ from: number; to: number }> = [];
  for (const m of markers) {
    if (counts.get(m.id) !== 1 || taken.has(m.id) || !refs.has(m.id)) continue;
    let end = tokens.length;
    for (let i = m.index + 1; i < tokens.length; i++) {
      if (marker(tokens[i], OPEN)) { end = i; break; }
      if (marker(tokens[i], CLOSE) === m.id) { end = i + 1; break; }
    }
    regions.push({ from: m.index, to: end });
  }
  replaceRegions(tokens, regions);
}

/** Filter only actual persisted containers; a plain anchor never makes a container. */
export function pageRootTokens(tokens: Token[], frontmatter: string): Token[] {
  if (!frontmatter) return tokens;
  const entries = entriesOf(frontmatter);
  const rows = layoutRows(structureValue(entries, 'layout'));
  const cards = canvasRefs(structureValue(entries, 'canvas'));
  const root = [...tokens];
  foldColumns(root, rows);
  foldCanvas(root, cards, rows);
  return root;
}
