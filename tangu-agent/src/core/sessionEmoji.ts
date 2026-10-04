/** A session icon is one complete emoji, including flags, modifiers and ZWJ sequences. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emojiChar = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;

export function normalizeSessionEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 32 || !emojiChar.test(text)) return null;
  return [...graphemes.segment(text)].length === 1 ? text : null;
}

export const HISTORIAN_EMOJI_FIELD = '"emoji": exactly one emoji representing the conversation topic, used as its session icon (for example "🔬" for research). No words or extra emojis. Keep emoji out of the title.';
