/**
 * Locale-independent title normalisation: Unicode NFKC, lower case, punctuation and symbols turned
 * into spaces, whitespace collapsed and trimmed. `toLowerCase` does not depend on the locale.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
