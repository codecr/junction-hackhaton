import { randomBytes } from 'node:crypto';
import { toBase64Url, type Envelope } from '@junction/core';
import { RelayClient, RelayError } from '@junction/relay/client';
import type { Junction } from './app';
import {
  ensureIdentity,
  importEnvelopes,
  loadCharter,
  loadCharterEnvelope,
  loadLocal,
  saveLocal,
  updateCharter,
  type ImportResult,
} from './squad';

// The squad server as a transport (ADR-004). It carries the same signed envelopes as a pasted
// block: the charter and each member's picks. Nothing else leaves the machine, and the squad
// server never sees an Events API token. If it is down, file and paste exchange still work.

export const DEFAULT_SQUAD_SERVER = 'https://api.junction.gerardo.dev';

export function relayClient(baseUrl?: string): RelayClient | undefined {
  const url = baseUrl ?? loadLocal().relayUrl;
  if (!url) return undefined;
  const me = ensureIdentity();
  return new RelayClient({
    baseUrl: url.replace(/\/$/, ''),
    kid: me.memberId,
    secretKey: me.secretKey,
    now: () => Date.now(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
  });
}

/** Leader: publish the squad rules to the squad server (create, or replace with a newer seq). */
export async function publishCharter(client: RelayClient): Promise<void> {
  const env = loadCharterEnvelope();
  const charter = loadCharter();
  if (!env || !charter) throw new Error('No squad yet. Run `junction squad create` first.');
  try {
    await client.createSquad(env);
  } catch (e) {
    if (!(e instanceof RelayError && e.status === 409)) throw e;
    try {
      await client.putCharter(charter.squadId, env);
    } catch (e2) {
      // The server already holds this seq or a newer one. Nothing to do.
      if (!(e2 instanceof RelayError && e2.status === 409)) throw e2;
    }
  }
}

/** Pushes my picks and pulls everyone's. Returns what was imported. */
export async function exchange(
  client: RelayClient,
  myManifest: Envelope | undefined,
): Promise<ImportResult> {
  const local = loadLocal();
  const me = ensureIdentity();
  let charter = loadCharter();
  const squadId = charter?.squadId ?? local.pendingSquadId;
  if (!squadId)
    throw new Error('No squad to sync with the squad server. Join or create one first.');
  if (charter?.leader === me.memberId) await publishCharter(client);
  if (myManifest && charter) {
    try {
      await client.putManifest(squadId, me.memberId, myManifest);
    } catch (e) {
      if (!(e instanceof RelayError && e.status === 409)) throw e;
    }
  }
  const snapshot = await client.getSquad(squadId);
  if (!snapshot) return { charterUpdated: false, manifestsAccepted: 0, rejected: [] };
  const result = importEnvelopes([snapshot.charter, ...snapshot.manifests]);
  charter = loadCharter();
  if (charter && local.pendingSquadId) saveLocal({ ...loadLocal(), pendingSquadId: undefined });
  return result;
}

/** Wires the squad server into `Junction.sync` when one is configured. */
export function attachRelay(app: Junction): void {
  app.relaySync = async (env) => {
    const client = relayClient();
    if (!client) return;
    try {
      await exchange(client, env);
    } catch (e) {
      // The squad server never blocks a member's own schedule (non-functional requirement).
      app.lastRelayError = e instanceof Error ? e.message : 'The squad server failed.';
      return;
    }
    app.lastRelayError = undefined;
  };
}

/** Invite code for the squad server: `<squadId>.<secret>`. */
export function inviteCode(): string {
  const charter = loadCharter();
  const local = loadLocal();
  if (!charter || !local.inviteSecret)
    throw new Error('Only the leader who created the squad has the invite.');
  return `${charter.squadId}.${local.inviteSecret}`;
}

export async function joinThroughServer(
  code: string,
  serverUrl: string,
): Promise<{ status: string; memberId: string }> {
  const m = /^(sq_[a-z2-7]{16})\.([A-Za-z0-9_-]{16,64})$/.exec(code.trim());
  if (!m)
    throw new Error(
      'That invite code does not look right. It should look like sq_xxxxxxxxxxxxxxxx.secret.',
    );
  const [, squadId, secret] = m as unknown as [string, string, string];
  const me = ensureIdentity();
  const client = relayClient(serverUrl)!;
  const r = await client.postJoinRequest(squadId, {
    publicKey: toBase64Url(me.publicKey),
    name: me.name,
    inviteSecret: secret,
  });
  saveLocal({ ...loadLocal(), relayUrl: serverUrl, pendingSquadId: squadId });
  return r;
}

/** Leader: list pending requests, or approve one by member id and publish the new rules. */
export async function pendingRequests(client: RelayClient) {
  const charter = loadCharter();
  if (!charter) throw new Error('No squad yet.');
  return client.listJoinRequests(charter.squadId);
}

export async function approveFromServer(
  client: RelayClient,
  memberId: string,
  now: string,
): Promise<string> {
  const reqs = await pendingRequests(client);
  const r = reqs.find((x) => x.memberId === memberId || x.memberId.startsWith(memberId));
  if (!r) throw new Error('No pending request from that member. Run `junction squad requests`.');
  const me = ensureIdentity();
  updateCharter(
    me,
    (c) => ({
      ...c,
      members: c.members.some((x) => x.memberId === r.memberId)
        ? c.members
        : [
            ...c.members,
            {
              memberId: r.memberId,
              name: r.name.slice(0, 40),
              publicKey: r.publicKey,
              role: 'member',
              joinedAt: now,
            },
          ],
    }),
    now,
  );
  await publishCharter(client);
  return r.name;
}
