import { describe, expect, it } from 'vitest';
import { baseOf, parseCode } from './codes';
import { SESSION_CODE_PATTERN } from './schemas';

describe('parseCode', () => {
  it.each([
    ['COM302', { base: 'COM302', suffix: '', index: undefined }],
    ['COM302-R', { base: 'COM302', suffix: 'R', index: undefined }],
    ['COM302-R1', { base: 'COM302', suffix: 'R', index: 1 }],
    ['OPS305-R12', { base: 'OPS305', suffix: 'R', index: 12 }],
    ['AGT4012', { base: 'AGT4012', suffix: '', index: undefined }],
    ['BSI403A', { base: 'BSI403A', suffix: '', index: undefined }],
    ['BSI403A-RX2', { base: 'BSI403A', suffix: 'RX', index: 2 }],
  ])('parses %s', (code, expected) => {
    expect(parseCode(code)).toEqual(expected);
  });

  it.each([
    '',
    'com302',
    'COM3',
    'COM30211',
    'C302',
    'COM302-',
    'COM302-r',
    'COM302-1',
    'COM302 R',
  ])('rejects %j', (code) => {
    expect(parseCode(code)).toBeUndefined();
  });

  it('accepts exactly the codes the manifest schema accepts', () => {
    for (const code of [
      'COM302',
      'COM302-R',
      'OPS305-R1',
      'com302',
      'COM3',
      'X',
      'COM302-',
      'ABCDEFG123',
    ]) {
      expect(parseCode(code) !== undefined, code).toBe(SESSION_CODE_PATTERN.test(code));
    }
  });

  it('gives the shared base for repeats', () => {
    expect(baseOf('COM302-R1')).toBe('COM302');
    expect(baseOf('COM302')).toBe('COM302');
    expect(baseOf('nope')).toBeUndefined();
  });
});
