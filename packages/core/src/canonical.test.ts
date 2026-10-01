import { describe, expect, it } from 'vitest';
import { fromUtf8 } from './bytes';
import { canonicalBytes, canonicalJson } from './canonical';

describe('canonicalJson (RFC 8785)', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe(
      '{"a":2,"b":1,"c":{"y":2,"z":1}}',
    );
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('uses the ES number format', () => {
    expect(canonicalJson([1.0, 1e21, 0.000001, -0, 100])).toBe('[1,1e+21,0.000001,0,100]');
  });

  it('escapes strings the JSON way and keeps non-ASCII as is', () => {
    expect(canonicalJson({ s: 'a"b\\c\né' })).toBe('{"s":"a\\"b\\\\c\\né"}');
  });

  it('sorts keys by UTF-16 code units, as the RFC requires', () => {
    // U+1F600 is a surrogate pair (0xD83D...) and sorts before U+FF21.
    expect(canonicalJson({ Ａ: 1, '\u{1F600}': 2 })).toBe('{"\u{1F600}":2,"Ａ":1}');
  });

  it('encodes bytes as UTF-8', () => {
    expect(fromUtf8(canonicalBytes({ n: 'é' }))).toBe('{"n":"é"}');
    expect(canonicalBytes({ n: 'é' })).toHaveLength('{"n":"é"}'.length + 1);
  });
});
