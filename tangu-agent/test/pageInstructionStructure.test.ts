import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { extractPageInstructions } from '../src/services/pageInstructions.js';

// Captured from the actual canvasCardSchema / columnRowSchema toMarkdown runners,
// remark-stringify and compileV4, not a guessed representation of nested Markdown.
const serialized = readFileSync(new URL('./fixtures/page-instructions/amadeus-structure-mixed.md', import.meta.url), 'utf8');
const roots = 'ROOT BEFORE\n\nROOT MIDDLE\n\nROOT AFTER';
const block = (s: string) => `\`\`\`forsion-instructions\n${s}\n\`\`\``;
const card = { v: 1, cards: [{ ref: 'card1', x: 0, y: 0, w: 400 }] };
const layout = { v: 4, rows: [{ columns: [{ refs: ['left'], width: 0.5 }, { refs: ['right'], width: 0.5 }], tail: 'tail1' }] };
const withFm = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`;

describe('page Instructions respect persisted Amadeus containers', () => {
  it('keeps all root blocks between real serialized cards and columns; ignores both nested kinds', () => {
    expect(extractPageInstructions(serialized)).toBe(roots);
  });

  it('does not activate a page that has only serialized nested instructions', () => {
    const nestedOnly = serialized.replace(/```forsion-instructions\nROOT (?:BEFORE|MIDDLE|AFTER)\n```/g, '');
    expect(extractPageInstructions(nestedOnly)).toBe('');
  });

  it('reads BOM / CRLF, quoted structural keys and externally reformatted multiline YAML', () => {
    const body = serialized.slice(serialized.indexOf('\n---\n') + 5);
    const fm = stringify({ amadeus_canvas: card, amadeus_layout: layout })
      .replace('amadeus_canvas:', '"amadeus_canvas":').replace('amadeus_layout:', "'amadeus_layout':");
    expect(extractPageInstructions('\uFEFF' + withFm(fm, body).replace(/\n/g, '\r\n'))).toBe(roots);
  });

  it('uses the last structural entry even when duplicate or unrelated frontmatter is invalid YAML', () => {
    const md = serialized.replace('amadeus_schema: amadeus.page/4', 'foreign: [broken\namadeus_canvas: {"v":1,"cards":[]}\namadeus_layout: {"v":4,"rows":[]}');
    expect(extractPageInstructions(md)).toBe(roots);
  });

  it('restores root semantics for unregistered inert anchors left by dissolved containers', () => {
    const md = serialized.replace(/^amadeus_canvas:.*$/m, 'amadeus_canvas: {"v":1,"cards":[]}')
      .replace(/^amadeus_layout:.*$/m, 'amadeus_layout: {"v":4,"rows":[]}');
    expect(extractPageInstructions(md)).toBe('ROOT BEFORE\n\nCARD HIDDEN\n\nROOT MIDDLE\n\nCOLUMN HIDDEN\n\nROOT AFTER');
  });

  it('invalid geometry disables the canvas structure, matching the editor', () => {
    const md = serialized.replace('"w":400', '"w":"400"');
    expect(extractPageInstructions(md)).toBe('ROOT BEFORE\n\nCARD HIDDEN\n\nROOT MIDDLE\n\nROOT AFTER');
  });

  it('a duplicate card ref in metadata or body prevents that card from folding', () => {
    const body = `<!-- a card1 -->\n\n${block('root')}\n\n<!-- /a card1 -->`;
    const duplicated = { ...card, cards: [card.cards[0], card.cards[0]] };
    expect(extractPageInstructions(withFm(`amadeus_canvas: ${JSON.stringify(duplicated)}`, body))).toBe('root');
    expect(extractPageInstructions(withFm(`amadeus_canvas: ${JSON.stringify(card)}`, body + '\n\n<!-- a card1 -->'))).toBe('root');
  });

  it('ends a legacy unclosed card at the next opening anchor, preserving subsequent roots', () => {
    const body = `<!-- a card1 -->\n\n${block('nested')}\n\n<!-- a inert -->\n\n${block('root')}`;
    expect(extractPageInstructions(withFm(`amadeus_canvas: ${JSON.stringify(card)}`, body))).toBe('root');
  });

  it('keeps root semantics for incomplete, reordered, or duplicate column anchors', () => {
    for (const md of [
      serialized.replace('"refs":["right"]', '"refs":["missing"]'),
      serialized.replace('"refs":["right"]', '"refs":["left"]'),
      serialized.replace('"refs":["left"]', '"refs":["right"]'),
      serialized.replace('<!-- a right -->', '<!-- a left -->'),
    ]) {
      expect(extractPageInstructions(md)).toBe('ROOT BEFORE\n\nROOT MIDDLE\n\nCOLUMN HIDDEN\n\nROOT AFTER');
    }
  });

  it('supports contiguous multiref legacy columns while leaving their tail-following root intact', () => {
    const md = serialized.replace('"refs":["left"]', '"refs":["left","left2"]')
      .replace('<!-- a right -->', `<!-- a left2 -->\n\n${block('ANOTHER NESTED')}\n\n<!-- a right -->`);
    expect(extractPageInstructions(md)).toBe(roots);
  });

  it('does not treat quoted or fenced marker examples as container boundaries', () => {
    const body = `> <!-- a card1 -->\n\n${block('root one')}\n\n\`\`\`html\n<!-- a card1 -->\n\`\`\`\n\n${block('root two')}`;
    expect(extractPageInstructions(withFm(`amadeus_canvas: ${JSON.stringify(card)}`, body))).toBe('root one\n\nroot two');
  });
});
