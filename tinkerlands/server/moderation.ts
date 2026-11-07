// Text filtering for chat, usernames and world titles. This is a baseline that
// stops the obvious cases; a public launch aimed at minors needs a dedicated
// moderation service as well (see README).

const DEFAULT_BLOCKED = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'pussy', 'slut', 'whore',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'spic', 'chink', 'tranny',
  'rape', 'rapist', 'nazi', 'hitler', 'porn', 'nude', 'nudes', 'sex', 'sexy',
  'kys', 'killyourself', 'snapchat', 'discord', 'whatsapp', 'telegram',
];

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i',
};

function normalizeChar(c: string): string {
  const lower = c.toLowerCase();
  return LEET[lower] ?? lower;
}

/** Characters that can spell a word, including common stand-ins like "@". */
const LETTER = /[\p{L}\p{N}@$!]/u;
/** Characters that continue a word, for deciding where one ends. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

export class TextFilter {
  private readonly words: string[];

  constructor(extra: string[] = []) {
    this.words = [...new Set([...DEFAULT_BLOCKED, ...extra])];
  }

  /** Replaces blocked words with asterisks, keeping everything else intact. */
  clean(text: string): string {
    const chars = Array.from(text);
    // Letters only, with a map back to the original positions, so "f u.c-k" and
    // "sh1t" are caught while the surrounding text is preserved.
    const norm: string[] = [];
    const origin: number[] = [];
    chars.forEach((c, i) => {
      if (LETTER.test(c)) {
        norm.push(normalizeChar(c));
        origin.push(i);
      }
    });
    const joined = norm.join('');
    const mask = new Array<boolean>(chars.length).fill(false);
    for (const word of this.words) {
      let at = joined.indexOf(word);
      while (at !== -1) {
        const start = origin[at];
        const end = origin[at + word.length - 1];
        if (this.spansOneWord(chars, start, end) && this.isWholeWord(chars, start, end, word)) {
          for (let i = start; i <= end; i++) if (LETTER.test(chars[i])) mask[i] = true;
        }
        at = joined.indexOf(word, at + 1);
      }
    }
    return chars.map((c, i) => (mask[i] ? '*' : c)).join('');
  }

  isClean(text: string): boolean {
    return this.clean(text) === text;
  }

  /**
   * A match may cross spaces only when spelled out letter by letter ("f u c k"),
   * so that innocent phrases like "this hit" are left alone.
   */
  private spansOneWord(chars: string[], start: number, end: number): boolean {
    const parts = chars.slice(start, end + 1).join('').split(/\s+/);
    return parts.length === 1 || parts.every((part) => Array.from(part).length === 1);
  }

  /**
   * Requires a word boundary around short words, so "class" and "assess" pass,
   * while long words are matched anywhere so "motherfucker" does not.
   */
  private isWholeWord(chars: string[], start: number, end: number, word: string): boolean {
    if (word.length >= 5 || word === 'fuck' || word === 'shit') return true;
    const before = start > 0 ? chars[start - 1] : ' ';
    const after = end < chars.length - 1 ? chars[end + 1] : ' ';
    return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
  }
}

/** Strips control and direction-override characters that can spoof display text. */
export function sanitizeText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
