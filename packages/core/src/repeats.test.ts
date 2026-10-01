import { describe, expect, it } from 'vitest';
import { session } from '../test/catalog-builders';
import { findRepeatGroups, groupOf } from './repeats';

const T0 = 28_000_000;

describe('findRepeatGroups', () => {
  it('groups an original and its repeats by base code and title', () => {
    const { groups, flags } = findRepeatGroups([
      session({
        sessionId: 'a',
        code: 'OPS305-R',
        title: 'Guardrails for generated infrastructure',
        startMin: T0 + 100,
      }),
      session({
        sessionId: 'b',
        code: 'OPS305-R1',
        title: 'Guardrails for Generated Infrastructure!',
        startMin: T0,
      }),
      session({ sessionId: 'c', code: 'DAT402', title: 'Zero-ETL at scale' }),
    ]);
    expect(flags).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ confidence: 'high', sessionIds: ['b', 'a'] }); // by start time
  });

  it('records what differs between repeats, in a fixed field order', () => {
    const { groups } = findRepeatGroups([
      session({
        sessionId: 'a',
        code: 'COM302-R',
        title: 'Community panel',
        type: 'Breakout',
        level: '300',
        features: ['community-led'],
        speakers: ['A', 'B'],
        venue: 'venetian',
        startMin: T0,
      }),
      session({
        sessionId: 'b',
        code: 'COM302-R1',
        title: 'Community panel',
        type: 'Breakout',
        level: '300',
        features: ['customer-story'],
        speakers: ['B', 'A'],
        venue: 'wynn',
        startMin: T0 + 1440,
      }),
    ]);
    // Speaker order does not count as a difference. Features, start and venue do.
    expect(groups[0]?.differences).toEqual(['features', 'start', 'venue']);
  });

  it('reports no differences for a true clone at another time in the same venue', () => {
    const { groups } = findRepeatGroups([
      session({ sessionId: 'a', code: 'COM302-R', title: 'Same', startMin: T0 }),
      session({ sessionId: 'b', code: 'COM302-R1', title: 'Same', startMin: T0 }),
    ]);
    expect(groups[0]?.differences).toEqual([]);
  });

  it('flags the same base code with different titles instead of grouping', () => {
    const { groups, flags } = findRepeatGroups([
      session({ sessionId: 'a', code: 'SEC303', title: 'Identity for agents', startMin: T0 }),
      session({
        sessionId: 'b',
        code: 'SEC303-R',
        title: 'Secrets in pipelines',
        startMin: T0 + 60,
      }),
    ]);
    expect(groups).toEqual([]);
    expect(flags).toEqual([
      { kind: 'same-base-different-title', base: 'SEC303', sessionIds: ['a', 'b'] },
    ]);
  });

  it('offers a probable group when only title, level and type match across bases', () => {
    const { groups } = findRepeatGroups([
      session({
        sessionId: 'a',
        code: 'AGT301',
        title: 'Agent memory',
        level: '300',
        type: 'Talk',
      }),
      session({
        sessionId: 'b',
        code: 'AGT399',
        title: 'Agent memory',
        level: '300',
        type: 'Talk',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe('probable');
  });

  it('does not link different bases when level differs', () => {
    const { groups } = findRepeatGroups([
      session({ sessionId: 'a', code: 'AGT301', title: 'Agent memory', level: '300' }),
      session({ sessionId: 'b', code: 'AGT399', title: 'Agent memory', level: '400' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('never groups sessions with an empty or punctuation-only title', () => {
    const { groups, flags } = findRepeatGroups([
      session({ sessionId: 'a', code: 'AGT301', title: '' }),
      session({ sessionId: 'b', code: 'AGT301-R', title: '---' }),
    ]);
    expect(groups).toEqual([]);
    expect(flags).toEqual([]);
  });

  it('does not group a session with itself, nor singletons', () => {
    expect(findRepeatGroups([session({ sessionId: 'a' })]).groups).toEqual([]);
    expect(findRepeatGroups([]).groups).toEqual([]);
  });

  it('gives the same result whatever order the sessions arrive in', () => {
    const input = [
      session({ sessionId: 'a', code: 'OPS305-R', title: 'Guardrails', startMin: T0 }),
      session({ sessionId: 'b', code: 'OPS305-R1', title: 'Guardrails', startMin: T0 + 10 }),
      session({ sessionId: 'c', code: 'SEC303', title: 'Identity' }),
      session({ sessionId: 'd', code: 'SEC303-R', title: 'Something else' }),
      session({ sessionId: 'e', code: 'FIN302', title: 'Caching', level: '300' }),
      session({ sessionId: 'f', code: 'FIN399', title: 'Caching', level: '300' }),
    ];
    const forward = findRepeatGroups(input);
    expect(findRepeatGroups([...input].reverse())).toEqual(forward);
    expect(
      findRepeatGroups([input[3]!, input[0]!, input[5]!, input[1]!, input[4]!, input[2]!]),
    ).toEqual(forward);
  });
});

describe('groupOf', () => {
  it('finds the high-confidence group of a session', () => {
    const analysis = findRepeatGroups([
      session({ sessionId: 'a', code: 'OPS305-R', title: 'Guardrails' }),
      session({ sessionId: 'b', code: 'OPS305-R1', title: 'Guardrails' }),
    ]);
    expect(groupOf(analysis, 'a')?.sessionIds).toContain('b');
    expect(groupOf(analysis, 'zzz')).toBeUndefined();
  });

  it('ignores probable groups', () => {
    const analysis = findRepeatGroups([
      session({ sessionId: 'a', code: 'AGT301', title: 'Same', level: '300' }),
      session({ sessionId: 'b', code: 'AGT399', title: 'Same', level: '300' }),
    ]);
    expect(groupOf(analysis, 'a')).toBeUndefined();
  });
});
