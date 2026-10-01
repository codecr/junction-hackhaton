import { describe, expect, it } from 'vitest';
import { normalizeText } from './text';

describe('normalizeText', () => {
  it('lower-cases, strips punctuation and collapses whitespace', () => {
    expect(normalizeText('  Zero-ETL   at Scale!  ')).toBe('zero etl at scale');
  });

  it('treats hyphen and space the same', () => {
    expect(normalizeText('Zero-ETL')).toBe(normalizeText('Zero ETL'));
  });

  it('applies Unicode NFKC, so full-width and ligature forms match', () => {
    expect(normalizeText('ＡＩ ﬁnance')).toBe('ai finance');
  });

  it('treats composed and decomposed accents as equal', () => {
    expect(normalizeText('Café')).toBe(normalizeText('Café'));
  });

  it('is not locale dependent (Turkish dotted I stays an ordinary lower-case i)', () => {
    expect(normalizeText('INFRA')).toBe('infra');
  });

  it('removes symbols and returns an empty string for nothing but punctuation', () => {
    expect(normalizeText('C++ & Rust')).toBe('c rust');
    expect(normalizeText('---')).toBe('');
  });
});
