import { describe, expect, it } from 'vitest';
import { normalizeSessionEmoji } from './sessionEmoji.js';

describe('session emoji', () => {
  it.each(['🔬', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣', '❤️'])('preserves the full grapheme %s', (emoji) => {
    expect(normalizeSessionEmoji(` ${emoji} `)).toBe(emoji);
  });
  it.each([null, undefined, 42, '', '   ', 'research', '🔬 science', '🔬🎨', '❤️'.repeat(20)])('rejects invalid icon %s', (emoji) => {
    expect(normalizeSessionEmoji(emoji)).toBeNull();
  });
});
