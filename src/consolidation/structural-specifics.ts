/**
 * Language-agnostic structural counters used to decide whether an
 * assistant message is worth a full LLM-driven hallucination audit.
 *
 * All three counters operate on character shape only (digits, quote
 * marks, paragraph boundaries), so they work across scripts and do
 * not need per-language stopword lists.
 *
 * - `countYearTokens`: 19xx / 20xx (and the Arabic-Indic equivalent).
 *   A canonical risk signal — the model invents a year more often
 *   than any other specific datum.
 * - `countDigitWordTokens`: digit-adjacent short letter runs ("5 km",
 *   "1947 a", "200kg"). Unicode-aware via the \p{L} class.
 * - `countQuotesOutsideUrlParagraphs`: quoted substrings in
 *   paragraphs that contain no URL. A URL nearby is taken as a proxy
 *   for "the quote is attributed to a source"; absence is a proxy
 *   for "the bot is putting words in someone's mouth without one".
 */

const ASCII_YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const ARABIC_INDIC_YEAR_RE = /[٠-٩]{4}/g;
const DIGIT_WORD_RE = /\d+\s?[\p{L}]{1,6}\b/gu;
const URL_RE = /https?:\/\//i;
const QUOTE_PATTERNS: RegExp[] = [
  /"[^"\n]+"/g,
  /'[^'\n]+'/g,
  /“[^”\n]+”/g,
  /‘[^’\n]+’/g,
  /«[^»\n]+»/g,
  /‹[^›\n]+›/g,
  /„[^“”\n]+[“”]/g,
  /『[^』\n]+』/g,
  /「[^」\n]+」/g,
];

export function countYearTokens(text: string): number {
  return (
    (text.match(ASCII_YEAR_RE)?.length ?? 0) +
    (text.match(ARABIC_INDIC_YEAR_RE)?.length ?? 0)
  );
}

export function countDigitWordTokens(text: string): number {
  return text.match(DIGIT_WORD_RE)?.length ?? 0;
}

export function countQuotesOutsideUrlParagraphs(text: string): number {
  const paragraphs = text.split(/\n\s*\n+/);
  let total = 0;
  for (const para of paragraphs) {
    if (URL_RE.test(para)) continue;
    for (const re of QUOTE_PATTERNS) {
      total += para.match(re)?.length ?? 0;
    }
  }
  return total;
}

export interface SpecificsCounters {
  lengthChars: number;
  yearTokens: number;
  digitWordTokens: number;
  quotedSubstrings: number;
}

export function measureSpecifics(text: string): SpecificsCounters {
  return {
    lengthChars: text.length,
    yearTokens: countYearTokens(text),
    digitWordTokens: countDigitWordTokens(text),
    quotedSubstrings: countQuotesOutsideUrlParagraphs(text),
  };
}
