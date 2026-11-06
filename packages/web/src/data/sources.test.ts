import { describe, expect, it } from 'vitest';
import { describeProposal } from '../lib/proposals';
import { createAgentSource, parseState } from './agent';
import { createDemoSource } from './demo';
import { SourceError } from './types';

describe('demo source', () => {
  it('signs in as Ana with the demo squad', async () => {
    const s = await createDemoSource().getState();
    expect(s.signedIn).toBe(true);
    expect(s.member?.name).toBe('Ana');
    expect(s.squad?.provisional).toBe(true);
  });

  it('accepts a proposal for me, reports each session, and undoes it', async () => {
    const source = createDemoSource();
    const before = (await source.getState()).squad!;
    const swap = before.proposals.find((p) => p.kind === 'SWAP' && p.memberId === before.me)!;
    expect(describeProposal(swap, before).title).toBe('Take OPS305-R1 on Wednesday instead');

    const out = await source.accept(swap.id);
    expect(out.results.map((r) => [r.code, r.action, r.ok])).toEqual([
      ['OPS305-R1', 'add', true],
      ['OPS305-R', 'remove', true],
    ]);
    const after = out.state.squad!;
    expect(after.coverage.duplicates.filter((d) => !d.planned)).toHaveLength(0);
    expect(after.proposals.some((p) => p.id === swap.id)).toBe(false);

    const back = await source.undo(swap.id);
    expect(back.results.map((r) => [r.code, r.action])).toEqual([
      ['OPS305-R', 'add'],
      ['OPS305-R1', 'remove'],
    ]);
    expect(back.state.squad!.coverage.duplicates.filter((d) => !d.planned)).toHaveLength(1);
  });

  it('refuses proposals meant for someone else', async () => {
    const source = createDemoSource();
    const view = (await source.getState()).squad!;
    const claim = view.proposals.find((p) => p.memberId !== view.me)!;
    await expect(source.accept(claim.id)).rejects.toBeInstanceOf(SourceError);
  });

  it('hides a declined proposal', async () => {
    const source = createDemoSource();
    const view = (await source.getState()).squad!;
    const id = view.proposals[0]!.id;
    const next = await source.decline(id);
    expect(next.squad!.proposals.some((p) => p.id === id)).toBe(false);
  });
});

describe('agent source', () => {
  const doc = {
    querySelectorAll: () => [{ content: 's3cret' }],
  } as unknown as Document;
  const empty = { signedIn: false, member: null, squad: null, lastSync: null, catalog: null };

  it('sends the page secret on every POST, never on GET', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith('/accept') ? { results: [], state: empty } : empty), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const source = createAgentSource(doc, f);
    await source.getState();
    await source.sync();
    await source.accept('abc/def');
    const headers = calls.map((c) => c.init.headers as Record<string, string>);
    expect(headers[0]?.['X-Junction-Secret']).toBeUndefined();
    expect(headers[1]?.['X-Junction-Secret']).toBe('s3cret');
    expect(calls[2]?.url).toBe('/api/proposals/abc%2Fdef/accept');
  });

  it('shows the agent message on errors', async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: { code: 'closed', message: 'Reservations open on 8 October.' } }), {
        status: 409,
      })) as unknown as typeof fetch;
    await expect(createAgentSource(doc, f).accept('x')).rejects.toMatchObject({
      code: 'closed',
      message: 'Reservations open on 8 October.',
    });
  });

  it('tells the user what to do when the agent is down', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createAgentSource(doc, f).getState()).rejects.toMatchObject({ code: 'agent-unreachable' });
  });

  it('rejects a state it does not understand', () => {
    expect(() => parseState({ signedIn: 'yes' })).toThrow(SourceError);
    expect(parseState(empty)).toEqual(empty);
  });
});
