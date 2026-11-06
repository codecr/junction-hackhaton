import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@junction/core';
import { RelayClient, RelayError } from './client';
import {
  INVITE_SECRET,
  charterFor,
  harness,
  member,
  nextNonce,
  signedCharter,
  signedClaim,
  signedManifest,
  signedSignal,
  type Harness,
  type Member,
} from './test-kit';

const ana = member('Ana', 21);
const luis = member('Luis', 22);
const mia = member('Mia', 23);
const squadId = charterFor([ana, luis]).squadId;

function clientFor(h: Harness, m: Member): RelayClient {
  return new RelayClient({
    baseUrl: 'https://relay.example.test/',
    kid: m.memberId,
    secretKey: m.keys.secretKey,
    now: () => h.clock.ms,
    randomBytes: () => nextNonce(),
    fetch: h.fetch,
  });
}

describe('RelayClient against the handler', () => {
  it('round-trips a squad', async () => {
    const h = harness();
    const a = clientFor(h, ana);
    const l = clientFor(h, luis);
    expect(await a.health()).toBe(true);
    expect(await a.createSquad(signedCharter([ana, luis]))).toEqual({ squadId, seq: 1 });

    const manifest = signedManifest(luis, squadId);
    await l.putManifest(squadId, luis.memberId, manifest);
    const snap = await a.getSquad(squadId);
    expect(snap?.manifests).toEqual([manifest]);
    expect(await a.getSquad(squadId, snap!.etag)).toBeUndefined();

    await a.putCharter(squadId, signedCharter([ana, luis], { seq: 2 }));
    const after = await l.getSquad(squadId, snap!.etag);
    expect(after).toBeDefined();
  });

  it('reports claim races without throwing', async () => {
    const h = harness();
    const a = clientFor(h, ana);
    const l = clientFor(h, luis);
    await a.createSquad(signedCharter([ana, luis]));
    expect((await a.postClaim(squadId, signedClaim(ana, squadId, 's-7'))).won).toBe(true);
    const lost = await l.postClaim(squadId, signedClaim(luis, squadId, 's-7'));
    expect(lost).toMatchObject({ won: false, winner: ana.memberId });
  });

  it('handles announcements, signals, join requests, leave and purge', async () => {
    const h = harness();
    const a = clientFor(h, ana);
    const l = clientFor(h, luis);
    const m = clientFor(h, mia);
    await a.createSquad(signedCharter([ana, luis]));

    expect((await a.postAnnouncement(squadId, 's-1')).first).toBe(true);
    expect(await l.postAnnouncement(squadId, 's-1')).toMatchObject({
      first: false,
      memberId: ana.memberId,
    });

    await l.postSignal(squadId, signedSignal(luis, squadId, 's-1', 'Hands-on.'));
    const page = await a.listSignals(squadId);
    expect(page.signals).toHaveLength(1);
    expect((await a.listSignals(squadId, page.cursor)).signals).toEqual([]);

    const join = await m.postJoinRequest(squadId, {
      publicKey: toBase64Url(mia.keys.publicKey),
      name: 'Mia',
      inviteSecret: INVITE_SECRET,
    });
    expect(join).toEqual({ memberId: mia.memberId, status: 'pending' });
    expect((await a.listJoinRequests(squadId)).map((r) => r.memberId)).toEqual([mia.memberId]);

    expect((await l.leave(squadId)).removed).toBe(1);
    expect((await a.purge(squadId)).purged).toBe(true);
    await expect(a.getSquad(squadId)).rejects.toBeInstanceOf(RelayError);
  });

  it('turns error responses into RelayError with the server message', async () => {
    const h = harness();
    const m = clientFor(h, mia);
    const err = await m.getSquad(squadId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).status).toBe(404);
    expect((err as RelayError).message).toMatch(/does not exist/);
  });
});
