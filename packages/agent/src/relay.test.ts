import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness } from '../../relay/src/test-kit';
import {
  approveFromServer,
  exchange,
  inviteCode,
  joinThroughServer,
  publishCharter,
  relayClient,
} from './relay';
import { createSquad, ensureIdentity, loadCharter, loadLocal, saveLocal } from './squad';

// Leader and member on two "machines" (two JUNCTION_HOME folders) talking through the real squad
// server handler in memory.

const URL_ = 'https://relay.example.test';
const home = () => mkdtempSync(join(tmpdir(), 'junction-relay-'));

afterEach(() => vi.unstubAllGlobals());

describe('squad server transport', () => {
  it('create, invite, join request, approve, and the member receives the squad rules', async () => {
    const h = harness();
    h.clock.ms = Date.now();
    vi.stubGlobal('fetch', h.fetch);

    const leaderHome = home();
    const memberHome = home();

    process.env.JUNCTION_HOME = leaderHome;
    const leader = ensureIdentity('Leader');
    createSquad(leader, {
      name: 'Test squad',
      eventId: 'reinvent2026',
      now: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      expiresAt: '2026-12-18T00:00:00Z',
    });
    saveLocal({ ...loadLocal(), relayUrl: URL_ });
    await publishCharter(relayClient()!);
    const code = inviteCode();

    process.env.JUNCTION_HOME = memberHome;
    const member = ensureIdentity('Member');
    const r = await joinThroughServer(code, URL_);
    expect(r.memberId).toBe(member.memberId);
    expect(loadCharter()).toBeUndefined();

    process.env.JUNCTION_HOME = leaderHome;
    expect(
      await approveFromServer(
        relayClient()!,
        member.memberId,
        new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      ),
    ).toBe('Member');

    process.env.JUNCTION_HOME = memberHome;
    const imported = await exchange(relayClient()!, undefined);
    expect(imported.charterUpdated).toBe(true);
    expect(
      loadCharter()
        ?.members.map((m) => m.name)
        .sort(),
    ).toEqual(['Leader', 'Member']);
    expect(loadLocal().pendingSquadId).toBeUndefined();
  });

  it('rejects a wrong invite secret', async () => {
    const h = harness();
    h.clock.ms = Date.now();
    vi.stubGlobal('fetch', h.fetch);
    process.env.JUNCTION_HOME = home();
    const leader = ensureIdentity('Leader');
    createSquad(leader, {
      name: 'Test squad',
      eventId: 'reinvent2026',
      now: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      expiresAt: '2026-12-18T00:00:00Z',
    });
    saveLocal({ ...loadLocal(), relayUrl: URL_ });
    await publishCharter(relayClient()!);
    const squadId = loadCharter()!.squadId;
    process.env.JUNCTION_HOME = home();
    ensureIdentity('Intruder');
    await expect(joinThroughServer(`${squadId}.wrong-secret-0000000`, URL_)).rejects.toThrow();
  });
});
